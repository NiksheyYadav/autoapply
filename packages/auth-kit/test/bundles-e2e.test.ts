import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../db/src/index.js';
import { buildDocx, buildPdf } from '../../../services/profile/test/fixtures.js';

/**
 * The committed `api/<service>/index.js` files are what Vercel runs. Everything else in the test
 * suite exercises the TypeScript sources; this boots the bundles themselves, as Vercel would (one
 * default-exported request handler per file, no listening socket), behind a real HTTP server, against
 * a real Postgres and a stand-in Supabase that serves a signing key. It catches what a bundle can get
 * wrong that the source cannot: a dependency left out or mis-bundled, a module that fails at import,
 * a route that is not wired.
 */
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVICES = ['admin', 'analytics', 'applications', 'auth', 'jobs', 'learning', 'matching', 'outreach', 'profile', 'referrals'] as const;
type Service = (typeof SERVICES)[number];

/** A path that needs a signed-in user, per service. */
const PROTECTED_PATH: Record<Service, string> = {
  admin: `/v1/admin/organizations/${randomUUID()}/students`,
  analytics: '/v1/analytics/summary',
  applications: '/v1/applications',
  auth: '/v1/auth/me',
  jobs: '/v1/jobs',
  learning: '/v1/learning/metrics',
  matching: '/internal/matching/drain',
  outreach: '/v1/messages',
  profile: '/v1/resumes',
  referrals: '/v1/referrals',
};

// The responses are checked field by field below; their exact types are the services' business.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response): Promise<any> => response.json();

describe.skipIf(!testDatabaseUrl)('the committed deploy bundles, booted for real', () => {
  const adminId = randomUUID();
  const userId = randomUUID();
  const cronSecret = `cron-${randomUUID()}`;
  const storageRoot = mkdtempSync(join(tmpdir(), 'atlas-bundles-'));
  const servers: Server[] = [];
  const bases = {} as Record<Service, string>;
  const modules: Array<{ app?: { close(): Promise<void> } }> = [];
  const apps = {} as Record<Service, { printRoutes(options?: object): string }>;
  let issuer: Server;
  let signingKey: CryptoKey;
  let handle: DatabaseHandle;
  let userToken: string;
  let adminToken: string;
  const savedEnv = { ...process.env };

  const token = async (sub: string, email: string): Promise<string> =>
    new SignJWT({ session_id: randomUUID(), email, app_metadata: {} })
      .setProtectedHeader({ alg: 'ES256', kid: 'bundle-key' })
      .setSubject(sub)
      .setIssuer(`${issuerBase}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(signingKey);
  let issuerBase = '';

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
      res.writeHead(req.url === '/auth/v1/.well-known/jwks.json' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(req.url === '/auth/v1/.well-known/jwks.json' ? JSON.stringify({ keys: [jwk] }) : '{}');
    });
    issuer = stub.server;
    issuerBase = stub.base;

    handle = createDatabase({ url: testDatabaseUrl! });
    for (const [id, email] of [[adminId, `bundle-admin-${adminId}@example.com`], [userId, `bundle-user-${userId}@example.com`]] as const) {
      await handle.sql`
        insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(), '{"provider":"email"}'::jsonb, '{"full_name":"Bundle Test"}'::jsonb, now(), now())
      `;
    }
    userToken = await token(userId, `bundle-user-${userId}@example.com`);
    adminToken = await token(adminId, `bundle-admin-${adminId}@example.com`);

    // What Vercel supplies, plus the configuration every service needs. VERCEL makes each bundle
    // export its handler instead of opening a socket.
    Object.assign(process.env, {
      VERCEL: '1',
      LOG_LEVEL: savedEnv.BUNDLE_TEST_LOG_LEVEL ?? 'fatal',
      DATABASE_URL: testDatabaseUrl,
      SUPABASE_URL: issuerBase,
      STORAGE_LOCAL_ROOT: storageRoot,
      PLATFORM_ADMIN_USER_IDS: adminId,
      CRON_SECRET: cronSecret,
      RATE_LIMIT_MAX: '100000',
    });
    for (const service of SERVICES) {
      const file = join(ROOT, 'api', service, 'index.js');
      expect(existsSync(file), `${file} is committed`).toBe(true);
      const mod = (await import(pathToFileURL(file).href)) as { default: (req: IncomingMessage, res: ServerResponse) => unknown; app?: { close(): Promise<void> } };
      expect(typeof mod.default, `${service} bundle default-exports a handler`).toBe('function');
      modules.push(mod);
      apps[service] = (mod as unknown as { app: { printRoutes(options?: object): string } }).app;
      const listening = await listen(mod.default);
      servers.push(listening.server);
      bases[service] = listening.base;
    }
  }, 120_000);

  afterAll(async () => {
    for (const mod of modules) await mod.app?.close().catch(() => undefined);
    for (const server of [...servers, issuer]) await new Promise((resolve) => server?.close(resolve));
    if (handle) {
      await handle.sql`delete from auth.users where id in (${adminId}, ${userId})`;
      await handle.close();
    }
    rmSync(storageRoot, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  const call = (service: Service, path: string, init: RequestInit & { bearer?: string } = {}) => {
    const { bearer, headers, ...rest } = init;
    return fetch(`${bases[service]}${path}`, {
      ...rest,
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(headers as Record<string, string> | undefined) },
    });
  };

  it.each(SERVICES)('%s: answers /health, and turns an anonymous caller away from its API', async (service) => {
    const health = await call(service, '/health');
    expect(health.status).toBe(200);
    const anonymous = await call(service, PROTECTED_PATH[service]);
    expect(anonymous.status).toBe(401);
    expect((await read(anonymous)).error).toMatchObject({ code: expect.any(String), request_id: expect.any(String) });
    const forged = await call(service, PROTECTED_PATH[service], { bearer: 'not.a.token' });
    expect(forged.status).toBe(401);
  });

  /** Every `{ method, path }` a booted app serves, read from Fastify's printed route tree. */
  function routesOf(service: Service): Array<{ method: string; path: string }> {
    const found: Array<{ method: string; path: string }> = [];
    const stack: string[] = [];
    for (const line of apps[service].printRoutes({ commonPrefix: false }).split('\n')) {
      const match = /^((?:│ {3}| {4})*)(?:├── |└── )(.+?)(?: \(([A-Z, ]+)\))?$/.exec(line);
      if (match === null) continue;
      const depth = (match[1] ?? '').length / 4;
      stack.length = depth;
      stack[depth] = match[2] as string;
      for (const method of (match[3] ?? '').split(', ').filter(Boolean)) found.push({ method, path: stack.join('') });
    }
    return found;
  }

  // The rule the whole API rests on: nothing but the probes answers a caller who has not signed in.
  // Walking the routes the deployed code really registers (rather than a list someone keeps up to
  // date) means a new route that forgets its authentication preHandler fails here.
  it('every route of every bundle other than /health and /metrics turns an anonymous caller and a forged token away', async () => {
    const probes = new Set(['/health', '/metrics']);
    const boundary = 'anonymous-boundary';
    let checked = 0;
    for (const service of SERVICES) {
      const routes = routesOf(service).filter(({ method, path }) => !probes.has(path) && method !== 'OPTIONS' && method !== 'HEAD' && path !== '*');
      expect(routes.length, `${service} has routes to check`).toBeGreaterThan(0);
      for (const { method, path } of routes) {
        const url = path.replace(/:\w+/g, () => randomUUID());
        const isUpload = method === 'POST' && path === '/v1/resumes';
        const body = method === 'GET' ? undefined : isUpload ? `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${boundary}--\r\n` : '{}';
        const headers = { 'content-type': isUpload ? `multipart/form-data; boundary=${boundary}` : 'application/json' };
        for (const bearer of [undefined, 'not.a.token']) {
          const response = await call(service, url, { method, body, headers: { ...headers, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
          expect(response.status, `${service} ${method} ${path} ${bearer ? 'with a forged token' : 'anonymously'}`).toBe(401);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(25);
  });

  it('auth: GET /v1/auth/me returns the signed-in user, and the export works', async () => {
    const me = await call('auth', '/v1/auth/me', { bearer: userToken });
    expect(me.status).toBe(200);
    expect(JSON.stringify(await read(me))).toContain(userId);
    const exported = await call('auth', '/v1/auth/me/export', { bearer: userToken });
    expect(exported.status).toBe(200);
  });

  let jobId = '';
  it('jobs: only a platform admin can ingest; the posting is then listed and readable', async () => {
    const posting = {
      source: 'manual',
      external_id: null,
      title: `Bundle Test Engineer ${userId.slice(0, 8)}`,
      company_name: `Bundle Test Co ${userId.slice(0, 8)}`,
      description: 'Build services in TypeScript and PostgreSQL.',
      location: 'Berlin',
      remote_type: 'remote',
      apply_url: 'https://example.com/jobs/1',
    };
    const refused = await call('jobs', '/v1/jobs/ingest', { method: 'POST', bearer: userToken, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ postings: [posting] }) });
    expect(refused.status).toBe(403);
    const ingested = await call('jobs', '/v1/jobs/ingest', { method: 'POST', bearer: adminToken, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ postings: [posting] }) });
    expect(ingested.status).toBe(200);
    expect(await read(ingested)).toMatchObject({ inserted: 1, rejected: 0 });

    const list = await call('jobs', '/v1/jobs?limit=100', { bearer: userToken });
    expect(list.status).toBe(200);
    const found = ((await read(list)).items as Array<{ job_id: string; title: string; company_name: string }>).find((job) => job.title === posting.title);
    expect(found?.company_name).toBe(posting.company_name);
    jobId = found!.job_id;
    const one = await call('jobs', `/v1/jobs/${jobId}`, { bearer: userToken });
    expect(one.status).toBe(200);
  });

  it('jobs: the scheduler route needs the secret and answers its report', async () => {
    expect((await call('jobs', '/internal/jobs/ingest-sources')).status).toBe(401);
    expect((await call('jobs', '/internal/jobs/ingest-sources', { bearer: 'wrong-secret-wrong-secret' })).status).toBe(401);
    const run = await call('jobs', '/internal/jobs/ingest-sources?limit=1', { bearer: cronSecret });
    expect(run.status).toBe(200);
  });

  const upload = async (name: string, type: string, bytes: Buffer) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
    return call('profile', '/v1/resumes', { method: 'POST', bearer: userToken, body: form });
  };
  let resumeId = '';

  it('profile: reads a text resume, a PDF and a DOCX inside the bundle (the parsing libraries are really there)', async () => {
    // The text resume goes last: matching scores against the latest parsed resume.
    const asPdf = await upload('resume.pdf', 'application/pdf', buildPdf(['Grace Hopper', 'Compiler pioneer. TypeScript. PostgreSQL.']));
    expect(asPdf.status).toBe(201);
    expect((await read(asPdf)).status, 'PDF upload').toBe('parsed');

    const asDocx = await upload(
      'resume.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buildDocx(['Alan Turing', 'Mathematician. Python. SQL.']),
    );
    expect(asDocx.status).toBe(201);
    expect((await read(asDocx)).status, 'DOCX upload').toBe('parsed');

    const text = Buffer.from(
      'Ada Lovelace\nada@example.com\n+1 555 123 4567\n\nSummary\nBackend engineer.\n\nExperience\nAcme Corp — Engineer\nJan 2019 - Present\n- Built TypeScript services serving 2M users\n\nSkills\nTypeScript, PostgreSQL, Node.js\n',
    );
    const asText = await upload('resume.txt', 'text/plain', text);
    expect(asText.status).toBe(201);
    const textBody = await read(asText);
    expect(textBody.status, 'text upload').toBe('parsed');
    resumeId = textBody.resume_id;

    const list = await call('profile', '/v1/resumes', { bearer: userToken });
    expect((await read(list)).items).toHaveLength(3);
  });

  it('profile: refuses a file that is not what it says', async () => {
    const liar = await upload('resume.pdf', 'application/pdf', Buffer.from('this is plain text, not a PDF'));
    expect([400, 415]).toContain(liar.status);
  });

  it('profile: a PDF decompression bomb (a 40 MB page in 40 KB) is recorded as too complex, quickly, not a crash', async () => {
    const stream = deflateSync(Buffer.alloc(40 * 1024 * 1024, 0x20), { level: 9 });
    const bomb = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 0 /Filter /FlateDecode >>\nstream\n', 'latin1'),
      stream,
      Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
    ]);
    expect(bomb.length).toBeLessThan(100 * 1024);
    const started = performance.now();
    const response = await upload('bomb.pdf', 'application/pdf', bomb);
    expect(response.status).toBe(201);
    const body = await read(response);
    expect(body.status).toBe('failed');
    expect(performance.now() - started).toBeLessThan(5_000);
    const stored = await read(await call('profile', `/v1/resumes/${body.resume_id}`, { bearer: userToken }));
    expect(JSON.stringify(stored)).toContain('too large or complex');
  });

  it('profile: optimizes the resume against the job', async () => {
    const res = await call('profile', `/v1/resumes/${resumeId}/optimize`, {
      method: 'POST',
      bearer: userToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    });
    expect(res.status).toBe(200);
  });

  it('applications: creates an application, replays it, and moves it through the lifecycle', async () => {
    const create = () =>
      call('applications', '/v1/applications', {
        method: 'POST',
        bearer: userToken,
        headers: { 'content-type': 'application/json', 'idempotency-key': 'bundle-e2e-key-0001' },
        body: JSON.stringify({ job_id: jobId, resume_id: resumeId, mode: 'manual' }),
      });
    const first = await create();
    expect(first.status).toBe(201);
    const applicationId = (await read(first)).application.application_id as string;
    expect((await create()).status).toBe(200);
    const moved = await call('applications', `/v1/applications/${applicationId}/events`, {
      method: 'POST',
      bearer: userToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_status: 'submitted' }),
    });
    expect(moved.status).toBe(200);
    expect((await read(moved)).application.status).toBe('submitted');
    const mine = await call('applications', '/v1/applications', { bearer: userToken });
    expect(((await read(mine)) as { items: unknown[] }).items).toHaveLength(1);
  });

  // The product's main loop, across four deployed functions and the Postgres outbox: a resume is parsed
  // (profile), a job is discovered (jobs), the matching consumer scores the pair when its drain route is
  // called, and the score shows up as a recommendation (jobs again).
  it('matching: after the drain, the uploaded resume produces a recommendation for the ingested job', async () => {
    const drain = await call('matching', '/internal/matching/drain?limit=1000&budget_ms=20000', { method: 'POST', bearer: cronSecret });
    expect(drain.status).toBe(200);
    const result = await read(drain);
    expect(result.processed ?? result.delivered ?? result.handled ?? 0, JSON.stringify(result)).toBeGreaterThan(0);

    const recommendations = await call('jobs', `/v1/jobs/recommendations?user_id=${userId}&limit=50`, { bearer: userToken });
    expect(recommendations.status).toBe(200);
    const items = (await read(recommendations)).items as Array<{ job: { job_id: string }; score: number; reasons: string[] }>;
    const mine = items.find((item) => item.job.job_id === jobId);
    expect(mine, `the ingested job is recommended (${items.length} items)`).toBeDefined();
    expect(mine!.score).toBeGreaterThan(0);
    expect(mine!.reasons.join(' ')).toMatch(/typescript|postgresql/i);
  });

  it('the other consumers drain cleanly too, and a drain with the wrong secret is refused', async () => {
    for (const [service, path] of [['learning', '/internal/learning/drain'], ['analytics', '/internal/analytics/drain'], ['referrals', '/internal/referrals/drain']] as const) {
      expect((await call(service, path, { method: 'POST' })).status, `${service} anonymous`).toBe(401);
      expect((await call(service, path, { method: 'POST', bearer: 'wrong-secret-wrong-secret' })).status, `${service} wrong secret`).toBe(401);
      const drained = await call(service, `${path}?limit=1000&budget_ms=20000`, { method: 'POST', bearer: cronSecret });
      expect(drained.status, `${service} drain`).toBe(200);
    }
  });

  it('a user cannot read another user\'s resume or application through the bundles', async () => {
    const outsider = randomUUID();
    await handle.sql`
      insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (${outsider}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${`bundle-outsider-${outsider}@example.com`}, now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now())
    `;
    try {
      const outsiderToken = await token(outsider, `bundle-outsider-${outsider}@example.com`);
      expect((await call('profile', `/v1/resumes/${resumeId}`, { bearer: outsiderToken })).status).toBe(404);
      const theirs = await call('applications', '/v1/applications', { bearer: outsiderToken });
      expect(((await read(theirs)) as { items: unknown[] }).items).toHaveLength(0);
    } finally {
      await handle.sql`delete from auth.users where id = ${outsider}`;
    }
  });
});
