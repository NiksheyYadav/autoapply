import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createBroker } from '@atlas/messaging';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadJobsServiceEnv } from '../src/env.js';
import { upsert } from '../src/repo/job-sources.js';

const SECRET = 'cron-secret-for-tests-0123456789';
const SUPABASE_URL = 'https://test-project.supabase.co';
const PATH = '/internal/jobs/ingest-sources';
// Nothing listens on port 1: requests that are turned away before the database never reach it.
const UNREACHABLE_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:1/atlas_ingest_sources_route';
// DB-backed cases self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

const opened: Array<{ app: FastifyInstance; handle: DatabaseHandle }> = [];

function build(
  options: { databaseUrl?: string; env?: Record<string, string | undefined>; fetch?: typeof fetch } = {},
): FastifyInstance {
  const env = loadJobsServiceEnv({
    DATABASE_URL: options.databaseUrl ?? UNREACHABLE_DATABASE_URL,
    PORT: '4003',
    SUPABASE_URL,
    LOG_LEVEL: 'fatal',
    CRON_SECRET: SECRET,
    ...options.env,
  });
  const handle = createDatabase({ url: env.DATABASE_URL, maxConnections: 4 });
  const app = buildApp({
    db: handle.db,
    sql: handle.sql,
    env,
    logger: createSilentLogger(),
    broker: createBroker({ driver: 'memory', logger: createSilentLogger() }),
    tokenVerifier: createTokenVerifierConfig(env),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  opened.push({ app, handle });
  return app;
}

afterEach(async () => {
  for (const { app, handle } of opened.splice(0)) {
    await app.close();
    await handle.close();
  }
});

const bearer = (secret: string = SECRET): Record<string, string> => ({ authorization: `Bearer ${secret}` });

describe('jobs-service /internal/jobs/ingest-sources: credentials', () => {
  it('answers 503 and never reads a board when CRON_SECRET is not configured', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const app = build({ env: { CRON_SECRET: undefined }, fetch: fetchSpy });

    for (const method of ['GET', 'POST'] as const) {
      for (const headers of [undefined, bearer()]) {
        const response = await app.inject({ method, url: PATH, ...(headers === undefined ? {} : { headers }) });
        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers 401 with a Bearer challenge when no credentials are sent', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const app = build({ fetch: fetchSpy });

    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url: PATH });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong secret', 'Bearer not-the-secret'],
    ['a truncated secret', `Bearer ${SECRET.slice(0, -1)}`],
    ['an extended secret', `Bearer ${SECRET}0`],
    ['a differently cased secret', `Bearer ${SECRET.toUpperCase()}`],
    ['another auth scheme', `Basic ${SECRET}`],
    ['a bare secret', SECRET],
    ['an empty bearer token', 'Bearer '],
  ])('answers 401 for %s', async (_label, authorization) => {
    const fetchSpy = vi.fn<typeof fetch>();
    const app = build({ fetch: fetchSpy });

    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url: PATH, headers: { authorization } });
      expect(response.statusCode).toBe(401);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not accept a user\'s access token or an admin session in place of the secret', async () => {
    const app = build({ env: { PLATFORM_ADMIN_USER_IDS: randomUUID() } });
    const response = await app.inject({ method: 'POST', url: PATH, headers: { authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.e30.sig' } });
    expect(response.statusCode).toBe(401);
  });

  it('checks credentials before it looks at the query', async () => {
    const app = build();

    const unauthenticated = await app.inject({ method: 'POST', url: `${PATH}?limit=0&budget_ms=1`, headers: { authorization: 'Bearer nope' } });
    expect(unauthenticated.statusCode).toBe(401);

    for (const query of ['budget_ms=60000', 'budget_ms=5', 'limit=0', 'limit=201', 'limit=abc', 'source_id=not-a-uuid']) {
      const response = await app.inject({ method: 'POST', url: `${PATH}?${query}`, headers: bearer() });
      expect(response.statusCode, query).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('is served at the service-scoped path only, and only for GET and POST', async () => {
    const app = build();

    expect((await app.inject({ method: 'GET', url: '/internal/ingest-sources', headers: bearer() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: PATH, headers: bearer() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: PATH, headers: bearer() })).statusCode).toBe(404);
  });

  it('refuses to boot with a CRON_SECRET too short to be a secret, or a contact that cannot go in a header', () => {
    const base = { DATABASE_URL: UNREACHABLE_DATABASE_URL, PORT: '4003', SUPABASE_URL };
    expect(() => loadJobsServiceEnv({ ...base, CRON_SECRET: 'short' })).toThrow(/CRON_SECRET/);
    expect(() => loadJobsServiceEnv({ ...base, JOB_SOURCE_CONTACT: 'café@example.com' })).toThrow(/JOB_SOURCE_CONTACT/);
    expect(() => loadJobsServiceEnv({ ...base, JOB_SOURCE_CONTACT: 'a\r\nb' })).toThrow(/JOB_SOURCE_CONTACT/);
    expect(loadJobsServiceEnv({ ...base }).CRON_SECRET).toBeUndefined();
  });
});

describe('jobs-service /internal/jobs/ingest-sources: rate limiting', () => {
  type Probe = { method: 'GET' | 'POST'; url: string; headers?: Record<string, string> };
  const statuses = async (app: FastifyInstance, count: number, request: Probe): Promise<number[]> => {
    const out: number[] = [];
    for (let attempt = 0; attempt < count; attempt += 1) out.push((await app.inject(request)).statusCode);
    return out;
  };

  it('never throttles the route (rejected callers get 401, not 429), and its requests spend no budget', async () => {
    const app = build({ env: { RATE_LIMIT_MAX: '3' } });

    expect(await statuses(app, 8, { method: 'POST', url: PATH })).toEqual(Array(8).fill(401));
    expect(await statuses(app, 8, { method: 'GET', url: PATH })).toEqual(Array(8).fill(401));
    // The business budget is untouched by all of that, and still enforced.
    expect(await statuses(app, 4, { method: 'GET', url: '/v1/jobs' })).toEqual([401, 401, 401, 429]);
  });

  it.skipIf(!testDatabaseUrl)('does not throttle authorized runs either', async () => {
    const app = build({ databaseUrl: testDatabaseUrl, env: { RATE_LIMIT_MAX: '3' } });
    const nobody = `source_id=${randomUUID()}`;

    const results = await statuses(app, 8, { method: 'GET', url: `${PATH}?${nobody}`, headers: bearer() });
    expect(results).toEqual(Array(8).fill(200));
    const sample = await app.inject({ method: 'GET', url: `${PATH}?${nobody}`, headers: bearer() });
    expect(sample.headers['x-ratelimit-limit']).toBeUndefined();
  });
});

describe.skipIf(!testDatabaseUrl)('jobs-service /internal/jobs/ingest-sources: a run', () => {
  const tag = randomUUID().slice(0, 8);
  const created: string[] = [];
  const companies: string[] = [];

  afterEach(async () => {
    const handle = createDatabase({ url: testDatabaseUrl!, maxConnections: 1 });
    for (const sourceId of created.splice(0)) {
      await handle.db.delete(schema.jobSources).where(eq(schema.jobSources.sourceId, sourceId));
    }
    for (const name of companies.splice(0)) {
      await handle.db.delete(schema.companies).where(eq(schema.companies.name, name));
    }
    await handle.close();
  });

  async function addSource(app: FastifyInstance, label: string): Promise<{ sourceId: string; boardToken: string }> {
    const { db } = opened.find((entry) => entry.app === app)!.handle;
    const companyName = `Route Co ${tag} ${label}`;
    companies.push(companyName);
    const { row } = await upsert(db, { provider: 'lever', boardToken: `route-${tag}-${label}`, companyName });
    created.push(row.sourceId);
    return { sourceId: row.sourceId, boardToken: row.boardToken };
  }

  const leverBody = (label: string): string =>
    JSON.stringify([
      { id: `${label}-1`, text: `Route Engineer ${label}`, categories: { location: 'Oslo' }, descriptionPlain: 'Work on TypeScript services.', applyUrl: 'https://jobs.lever.co/x/1/apply' },
    ]);

  it('runs the named source and returns the counts, on GET (the scheduler) and on POST (by hand)', async () => {
    const seenHeaders: Headers[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      seenHeaders.push(new Headers(init?.headers));
      expect(String(input)).toContain('https://api.lever.co/v0/postings/route-');
      return new Response(leverBody(`${tag}-a`), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const app = build({ databaseUrl: testDatabaseUrl, env: { JOB_SOURCE_CONTACT: 'jobs-ingest@example.com' }, fetch: fetchStub });
    const { sourceId } = await addSource(app, 'a');

    const first = await app.inject({ method: 'GET', url: `${PATH}?source_id=${sourceId}`, headers: bearer() });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      sources_total: 1,
      attempted: 1,
      succeeded: 1,
      failed: 0,
      not_attempted: 0,
      inserted: 1,
      updated: 0,
      duplicates: 0,
      rejected: 0,
      deactivated: 0,
    });
    expect(first.json().sources).toHaveLength(1);
    expect(first.json().sources[0]).toMatchObject({ source_id: sourceId, provider: 'lever', status: 'ok', fetched: 1, inserted: 1 });
    expect(typeof first.json().duration_ms).toBe('number');

    // The second run, by POST, finds nothing new.
    const second = await app.inject({ method: 'POST', url: `${PATH}?source_id=${sourceId}`, headers: bearer() });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ inserted: 0, duplicates: 1 });

    expect(seenHeaders).toHaveLength(2);
    for (const headers of seenHeaders) {
      expect(headers.get('user-agent')).toMatch(/^AtlasJobIngest\/\d.*contact: jobs-ingest@example\.com/);
      expect(headers.has('authorization')).toBe(false);
    }
  });

  it('reports a failing board in the body without failing the request', async () => {
    const fetchStub: typeof fetch = async () => new Response('down', { status: 503 });
    const app = build({ databaseUrl: testDatabaseUrl, fetch: fetchStub });
    const { sourceId } = await addSource(app, 'b');

    const response = await app.inject({ method: 'POST', url: `${PATH}?source_id=${sourceId}`, headers: bearer() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(response.json().sources[0]).toMatchObject({ status: 'error', error: expect.stringContaining('503') });
  });
});
