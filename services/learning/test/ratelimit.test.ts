import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, type DatabaseHandle } from '@atlas/db';
import { createBroker, type DrainableBroker, type DrainOptions } from '@atlas/messaging';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadLearningServiceEnv } from '../src/env.js';

const SECRET = 'cron-secret-for-tests-0123456789';
const SUPABASE_URL = 'https://test-project.supabase.co';
// Nothing listens on port 1. Every request below is turned away before it reaches the database
// (a 401 for a missing token, a 404 or a 429), and /health reports a degraded database quickly.
const UNREACHABLE_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:1/atlas_learning_ratelimit';

type StubBroker = DrainableBroker & { calls: DrainOptions[] };

function stubBroker(): StubBroker {
  const calls: DrainOptions[] = [];
  return {
    calls,
    publish: async () => undefined,
    subscribe: async (options) => ({ consumer: options.consumer, stop: async () => undefined }),
    isHealthy: () => true,
    close: async () => undefined,
    drain: async (options) => {
      calls.push(options ?? {});
      return { processed: 0, failed: 0, dead: 0, purged: 0 };
    },
  };
}

const opened: Array<{ app: FastifyInstance; handle: DatabaseHandle }> = [];

async function build(
  envOverrides: Record<string, string> = {},
  broker: DrainableBroker | ReturnType<typeof createBroker> = createBroker({
    driver: 'memory',
    logger: createSilentLogger(),
  }),
): Promise<FastifyInstance> {
  const env = loadLearningServiceEnv({
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    PORT: '4008',
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
    broker,
    tokenVerifier: createTokenVerifierConfig(env),
  });
  opened.push({ app, handle });
  await app.ready();
  return app;
}

afterEach(async () => {
  for (const { app, handle } of opened.splice(0)) {
    await app.close();
    await handle.close();
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
describe('learning-service rate limiting', () => {
  it('throttles business routes once the configured maximum is reached and answers 429 RATE_LIMITED', async () => {
    const app = await build();

    expect(await statuses(app, 5, { method: 'GET', url: '/v1/learning/metrics' })).toEqual([
      401, 401, 401, 429, 429,
    ]);

    const throttled = await app.inject({ method: 'GET', url: '/v1/learning/metrics' });
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
      const res = await app.inject({ method: 'GET', url: '/v1/learning/metrics' });
      expect(res.headers['x-ratelimit-limit']).toBe('3');
      remaining.push(String(res.headers['x-ratelimit-remaining']));
    }
    expect(remaining).toEqual(['2', '1', '0']);

    const throttled = await app.inject({ method: 'GET', url: '/v1/learning/metrics' });
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
      (await app.inject({ method: 'GET', url: '/v1/learning/metrics' })).statusCode,
      (await app.inject({ method: 'GET', url: '/v1/not-a-route' })).statusCode,
      (await app.inject({ method: 'GET', url: '/v1/learning/metrics' })).statusCode,
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
      url: '/v1/learning/metrics',
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
    expect(await statuses(app, 3, { method: 'GET', url: '/v1/learning/metrics' })).toEqual([
      401, 401, 401,
    ]);
    // ...and once it is spent, the probes still answer.
    expect((await app.inject({ method: 'GET', url: '/v1/learning/metrics' })).statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(probe.statusCode);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  // The scheduler calls these every five minutes with a bearer secret; throttling them would
  // quietly stall every event delivery.
  it('never throttles the drain routes, however often the scheduler calls them', async () => {
    const broker = stubBroker();
    const app = await build({ CRON_SECRET: SECRET }, broker);
    const authorized = { authorization: `Bearer ${SECRET}` };

    const seen: number[] = [];
    for (const url of ['/internal/drain', '/internal/learning/drain']) {
      for (const method of ['GET', 'POST'] as const) {
        seen.push(...(await statuses(app, 5, { method, url, headers: authorized })));
      }
    }
    expect(seen).toEqual(Array(20).fill(200));
    expect(broker.calls).toHaveLength(20);

    // Rejected callers get the drain route's own 401, not a 429, and spend no business budget.
    expect(await statuses(app, 5, { method: 'POST', url: '/internal/drain' })).toEqual(
      Array(5).fill(401),
    );
    expect(await statuses(app, 3, { method: 'GET', url: '/v1/learning/metrics' })).toEqual([
      401, 401, 401,
    ]);
  });
});
