import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadConnectorsServiceEnv } from '../src/env.js';
import { createSecretStore } from '../src/lib/secret-store.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const SUPABASE_URL = 'https://test-project.supabase.co';

let signTestToken: (claims: { sub: string; sid: string; org: string | null; role: string | null; email: string }) => Promise<string>;

// createRemoteJWKSet fetches over HTTP — stub it to serve a locally
// generated key instead of hitting a real Supabase project.
async function stubJwks(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );

  signTestToken = async (claims) =>
    new SignJWT({ session_id: claims.sid, email: claims.email, app_metadata: { org_id: claims.org, role: claims.role } })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(claims.sub)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(privateKey);
}

describe.skipIf(!testDatabaseUrl)('connectors-service HTTP flow', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let secretsRoot: string;
  let token: string;
  let otherToken: string;
  const userId = randomUUID();
  const otherUserId = randomUUID();

  beforeAll(async () => {
    await stubJwks();
    const env = loadConnectorsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4011', SUPABASE_URL });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    secretsRoot = await mkdtemp(join(tmpdir(), 'atlas-connectors-test-'));
    const secretStore = createSecretStore({ driver: 'local', localRoot: secretsRoot });
    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      secretStore,
      tokenVerifier: createTokenVerifierConfig(env),
    });
    await app.ready();

    // public.users.user_id FKs to auth.users.id (see packages/db/supabase/auth-hooks.sql);
    // inserting into auth.users fires handle_new_user, which creates the matching
    // public.users row itself.
    for (const u of [
      { id: userId, email: `connectors-flow-${userId}@example.com`, fullName: 'User' },
      { id: otherUserId, email: `connectors-flow-other-${otherUserId}@example.com`, fullName: 'Other User' },
    ]) {
      await dbHandle.sql`
        insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values (${u.id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${u.email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: u.fullName })}::jsonb, now(), now())
      `;
    }

    token = await signTestToken({ sub: userId, sid: randomUUID(), org: null, role: null, email: 'user@example.com' });
    otherToken = await signTestToken({ sub: otherUserId, sid: randomUUID(), org: null, role: null, email: 'other@example.com' });
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.connectorAccounts).where(eq(schema.connectorAccounts.userId, userId));
    await dbHandle.db.delete(schema.connectorAccounts).where(eq(schema.connectorAccounts.userId, otherUserId));
    // Cascades to public.users via the auth.users FK.
    await dbHandle.sql`delete from auth.users where id in (${userId}, ${otherUserId})`;
    await app.close();
    await dbHandle.close();
    await rm(secretsRoot, { recursive: true, force: true });
  });

  it('lists every provider as disconnected before any connection exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/connectors', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers.every((p: { connected: boolean }) => p.connected === false)).toBe(true);
  });

  it('404s connecting an unknown provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/not-a-real-provider/connect',
      headers: { authorization: `Bearer ${token}` },
      payload: { external_account_id: 'board-1', credential: 'secret-token', consent: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires explicit consent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/greenhouse/connect',
      headers: { authorization: `Bearer ${token}` },
      payload: { external_account_id: 'board-1', credential: 'secret-token' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('connects a provider and never returns the credential', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/greenhouse/connect',
      headers: { authorization: `Bearer ${token}` },
      payload: { external_account_id: 'board-1', credential: 'secret-token', consent: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.connector.status).toBe('active');
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(body.connector.secret_ref).toBeUndefined();
  });

  it('reconnecting the same provider replaces the row instead of duplicating it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/greenhouse/connect',
      headers: { authorization: `Bearer ${token}` },
      payload: { external_account_id: 'board-1-renamed', credential: 'new-secret-token', consent: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connector.external_account_id).toBe('board-1-renamed');

    const rows = await dbHandle.db.select().from(schema.connectorAccounts).where(eq(schema.connectorAccounts.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('rejects a different user claiming the same external account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/greenhouse/connect',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { external_account_id: 'board-1-renamed', credential: 'someone-elses-token', consent: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it('disconnects a provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/greenhouse/disconnect',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connector.status).toBe('revoked');
  });

  it('404s disconnecting a provider that was never connected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/lever/disconnect',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
