import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../db/src/index.js';
import { buildDocx, buildPdf } from '../../../services/profile/test/fixtures.js';

/**
 * `api/profile/index.js` is what Vercel runs. The profile service's own tests run its TypeScript
 * sources, where pdf.js finds its worker file inside node_modules; inside the bundle it looks for
 * `api/profile/pdf.worker.mjs`, which does not exist, so every PDF upload ended as "failed". This
 * boots the committed bundle as Vercel would (one default-exported handler, no listening socket)
 * behind real HTTP, against a real Postgres and a stand-in key server, and uploads each supported
 * resume format through it.
 */
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const BUNDLE = join(fileURLToPath(new URL('../../../', import.meta.url)), 'api', 'profile', 'index.js');

describe.skipIf(!testDatabaseUrl)('the committed profile bundle, booted for real', () => {
  const userId = randomUUID();
  const email = `profile-bundle-${userId}@example.com`;
  const storageRoot = mkdtempSync(join(tmpdir(), 'atlas-profile-bundle-'));
  const savedEnv = { ...process.env };
  let signingKey: CryptoKey;
  let issuer: Server;
  let api: Server;
  let apiBase = '';
  let issuerBase = '';
  let handle: DatabaseHandle;
  let app: { close(): Promise<void> } | undefined;
  let bearer = '';

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<{ server: Server; base: string }> {
    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'bundle-key', alg: 'ES256', use: 'sig' };
    const stub = await listen((req, res) => {
      const found = req.url === '/auth/v1/.well-known/jwks.json';
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(found ? JSON.stringify({ keys: [jwk] }) : '{}');
    });
    issuer = stub.server;
    issuerBase = stub.base;

    handle = createDatabase({ url: testDatabaseUrl! });
    await handle.sql`
      insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(), '{"provider":"email"}'::jsonb, '{"full_name":"Bundle Test"}'::jsonb, now(), now())
    `;
    bearer = await new SignJWT({ session_id: randomUUID(), email, app_metadata: {} })
      .setProtectedHeader({ alg: 'ES256', kid: 'bundle-key' })
      .setSubject(userId)
      .setIssuer(`${issuerBase}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(signingKey);

    // What Vercel supplies, plus the configuration the service needs. VERCEL makes the bundle export
    // its handler instead of opening a socket.
    Object.assign(process.env, {
      VERCEL: '1',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: testDatabaseUrl,
      SUPABASE_URL: issuerBase,
      STORAGE_LOCAL_ROOT: storageRoot,
      RATE_LIMIT_MAX: '100000',
    });
    expect(existsSync(BUNDLE), `${BUNDLE} is committed`).toBe(true);
    const mod = (await import(pathToFileURL(BUNDLE).href)) as {
      default: (req: IncomingMessage, res: ServerResponse) => unknown;
      app?: { close(): Promise<void> };
    };
    app = mod.app;
    const listening = await listen(mod.default);
    api = listening.server;
    apiBase = listening.base;
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await new Promise((resolve) => api?.close(resolve));
    await new Promise((resolve) => issuer?.close(resolve));
    if (handle) {
      await handle.sql`delete from auth.users where id = ${userId}`;
      await handle.close();
    }
    rmSync(storageRoot, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  const upload = async (name: string, type: string, bytes: Buffer) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
    const response = await fetch(`${apiBase}/v1/resumes`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: form });
    return { status: response.status, body: (await response.json()) as { resume_id?: string; status?: string } };
  };

  it('answers /health and turns an anonymous caller away', async () => {
    expect((await fetch(`${apiBase}/health`)).status).toBe(200);
    expect((await fetch(`${apiBase}/v1/resumes`)).status).toBe(401);
  });

  it('parses a PDF resume (pdf.js finds its worker inside the bundle)', async () => {
    const result = await upload('resume.pdf', 'application/pdf', buildPdf(['Grace Hopper', 'Compiler pioneer. TypeScript. PostgreSQL.']));
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('parsed');
  });

  it('parses a DOCX resume', async () => {
    const result = await upload(
      'resume.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buildDocx(['Alan Turing', 'Mathematician. Python. SQL.']),
    );
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('parsed');
  });

  it('parses a plain-text resume', async () => {
    const text = Buffer.from('Ada Lovelace\nada@example.com\n\nSkills\nTypeScript, PostgreSQL\n');
    const result = await upload('resume.txt', 'text/plain', text);
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('parsed');
  });
});
