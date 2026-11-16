import { tmpdir } from 'node:os';
import { join } from 'node:path';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, type DatabaseHandle } from '@atlas/db';
import { createLocalDriver } from '@atlas/storage';
import { registerRateLimitedRoutes } from '@atlas/observability';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadAuthServiceEnv } from '../src/env.js';

const SUPABASE_URL = 'https://test-project.supabase.co';
// Nothing listens on port 1. Every request below is turned away before it reaches the database
// (a 401 for a missing token, a 404 or a 429), and /health reports a degraded database quickly.
const UNREACHABLE_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:1/atlas_auth_ratelimit';

const opened: Array<{ app: FastifyInstance; handle?: DatabaseHandle }> = [];

async function build(envOverrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const env = loadAuthServiceEnv({
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    PORT: '4001',
    SUPABASE_URL,
    LOG_LEVEL: 'fatal',
    RATE_LIMIT_MAX: '3',
    ...envOverrides,
  });
  const handle = createDatabase({ url: env.DATABASE_URL });
  const app = buildApp({
    db: handle.db,
    sql: handle.sql,
    env,
    logger: createSilentLogger(),
    tokenVerifier: createTokenVerifierConfig(env),
    // Never reached: every request here is turned away before it could delete anything.
    storage: createLocalDriver({ root: join(tmpdir(), 'atlas-auth-ratelimit-test') }),
  });
  opened.push({ app, handle });
  await app.ready();
  return app;
}

afterEach(async () => {
  for (const { app, handle } of opened.splice(0)) {
    await app.close();
    await handle?.close();
  }
});

type TestRequest = { method: 'GET' | 'POST'; url: string; headers?: Record<string, string> };

/** Statuses of `count` sequential requests. A 401 (no token) counts against the limit like any other. */
async function statuses(
  app: FastifyInstance,
  count: number,
  request: TestRequest,
): Promise<number[]> {
  const out: number[] = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    out.push((await app.inject(request)).statusCode);
  }
  return out;
}

// Rate limiting attaches to routes through an `onRoute` hook that only exists once the
// (asynchronously loaded) @fastify/rate-limit plugin is up, so routes declared directly on the
// root app right after `register(rateLimit)` are silently not limited. See app.ts.
describe('auth-service rate limiting', () => {
  it('throttles business routes once the configured maximum is reached and answers 429 RATE_LIMITED', async () => {
    const app = await build();

    expect(await statuses(app, 5, { method: 'GET', url: '/v1/auth/me' })).toEqual([
      401, 401, 401, 429, 429,
    ]);

    const throttled = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error).toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('Rate limit exceeded'),
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('sends sane rate-limit headers: a decreasing budget, then Retry-After on the 429', async () => {
    const app = await build({ RATE_LIMIT_WINDOW: '30 seconds' });

    const remaining: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await app.inject({ method: 'GET', url: '/v1/auth/me' });
      expect(res.headers['x-ratelimit-limit']).toBe('3');
      remaining.push(String(res.headers['x-ratelimit-remaining']));
    }
    expect(remaining).toEqual(['2', '1', '0']);

    const throttled = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['x-ratelimit-limit']).toBe('3');
    expect(throttled.headers['x-ratelimit-remaining']).toBe('0');
    // The configured RATE_LIMIT_WINDOW is what sizes the wait, not the plugin default of a minute.
    const retryAfter = Number(throttled.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
    expect(Number(throttled.headers['x-ratelimit-reset'])).toBe(retryAfter);
  });

  it('counts unknown routes against the same budget, so probing for paths cannot run free', async () => {
    const app = await build();

    const seen = [
      (await app.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode,
      (await app.inject({ method: 'GET', url: '/v1/not-a-route' })).statusCode,
      (await app.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode,
    ];
    expect(seen).toEqual([401, 404, 401]);

    const throttled = await app.inject({ method: 'GET', url: '/v1/not-a-route' });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error.code).toBe('RATE_LIMITED');
  });

  it('keeps a separate budget per client address', async () => {
    const app = await build();
    const asClient = (address: string): TestRequest => ({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { 'x-forwarded-for': address },
    });

    expect(await statuses(app, 4, asClient('203.0.113.10'))).toEqual([401, 401, 401, 429]);
    // A different client is unaffected by the first one running out.
    expect(await statuses(app, 3, asClient('203.0.113.11'))).toEqual([401, 401, 401]);
  });

  it('never throttles /health or /metrics, and they do not spend the budget either', async () => {
    const app = await build();

    const probe = await app.inject({ method: 'GET', url: '/health' });
    const probeStatuses = await statuses(app, 10, { method: 'GET', url: '/health' });
    expect(probeStatuses.every((status) => status === probe.statusCode)).toBe(true);
    expect(probe.statusCode).not.toBe(429);
    expect(probe.headers['x-ratelimit-limit']).toBeUndefined();
    expect(await statuses(app, 10, { method: 'GET', url: '/metrics' })).toEqual(
      Array(10).fill(200),
    );

    // The probes above did not touch the business budget...
    expect(await statuses(app, 3, { method: 'GET', url: '/v1/auth/me' })).toEqual([401, 401, 401]);
    // ...and once it is spent, the probes still answer.
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(probe.statusCode);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });
});

// The shared helper behind every service's app.ts. It is exercised here (rather than in
// packages/observability) because this package already resolves the plugin it is handed.
describe('registerRateLimitedRoutes', () => {
  const settings = { max: 100, timeWindow: '1 minute' };
  const ok = async () => ({ ok: true });

  async function helperApp(
    options: { routeLimits?: Record<string, { max: number; timeWindow: string }> } = {},
  ): Promise<FastifyInstance> {
    const app = Fastify();
    opened.push({ app });
    app.get('/probe', ok);
    registerRateLimitedRoutes(app, { plugin: rateLimit, settings, ...options }, (scope) => {
      scope.get('/limited', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, ok);
      scope.post('/table', ok);
      scope.get('/own', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, ok);
    });
    // Declared after the call, still on the root: order is not what keeps a route unlimited.
    app.get('/late-probe', ok);
    return app;
  }

  it('limits routes declared in the scope and leaves routes declared on the app alone', async () => {
    const app = await helperApp();

    expect(await statuses(app, 5, { method: 'GET', url: '/limited' })).toEqual([
      200, 200, 429, 429, 429,
    ]);
    expect(await statuses(app, 5, { method: 'GET', url: '/probe' })).toEqual(Array(5).fill(200));
    expect(await statuses(app, 5, { method: 'GET', url: '/late-probe' })).toEqual(
      Array(5).fill(200),
    );
  });

  it('applies a limit from the table, and lets a limit written on the route win over the table', async () => {
    const app = await helperApp({
      routeLimits: {
        'POST /table': { max: 2, timeWindow: '1 minute' },
        'GET /own': { max: 50, timeWindow: '1 minute' },
      },
    });

    expect(await statuses(app, 3, { method: 'POST', url: '/table' })).toEqual([200, 200, 429]);
    expect(await statuses(app, 3, { method: 'GET', url: '/own' })).toEqual([200, 429, 429]);
  });

  it('refuses to start when a configured limit matches no route', async () => {
    const app = await helperApp({
      routeLimits: { 'POST /renamed-away': { max: 1, timeWindow: '1 minute' } },
    });

    await expect(app.ready()).rejects.toThrow(/POST \/renamed-away/);
  });
});
