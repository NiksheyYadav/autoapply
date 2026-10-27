import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, type DatabaseHandle } from '@atlas/db';
import { createBroker } from '@atlas/messaging';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadOutreachServiceEnv } from '../src/env.js';
import { createTransport } from '../src/lib/transport.js';

const SUPABASE_URL = 'https://test-project.supabase.co';
// Nothing listens on port 1. Every request below is turned away before it reaches the database
// (a 401 for a missing token, a 404 or a 429), and /health reports a degraded database quickly.
const UNREACHABLE_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:1/atlas_outreach_ratelimit';

// Sending has its own, stricter limit (ROUTE_LIMITS in app.ts).
const SEND_LIMIT = 20;
const MESSAGE_A = '3f1d8a52-0000-4000-8000-00000000000a';
const MESSAGE_B = '3f1d8a52-0000-4000-8000-00000000000b';

const opened: Array<{ app: FastifyInstance; handle: DatabaseHandle }> = [];

async function build(envOverrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const env = loadOutreachServiceEnv({
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    PORT: '4007',
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
    broker: createBroker({ driver: 'memory', logger: createSilentLogger() }),
    transport: createTransport({ driver: 'local', logger: createSilentLogger() }),
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
describe('outreach-service rate limiting', () => {
  it('throttles business routes once the configured maximum is reached and answers 429 RATE_LIMITED', async () => {
    const app = await build();

    expect(await statuses(app, 5, { method: 'GET', url: '/v1/messages' })).toEqual([
      401, 401, 401, 429, 429,
    ]);

    const throttled = await app.inject({ method: 'GET', url: '/v1/messages' });
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
      const res = await app.inject({ method: 'GET', url: '/v1/messages' });
      expect(res.headers['x-ratelimit-limit']).toBe('3');
      remaining.push(String(res.headers['x-ratelimit-remaining']));
    }
    expect(remaining).toEqual(['2', '1', '0']);

    const throttled = await app.inject({ method: 'GET', url: '/v1/messages' });
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

  it('spends one budget across the other business routes', async () => {
    const app = await build();

    const sequence: TestRequest[] = [
      { method: 'GET', url: '/v1/messages' },
      { method: 'GET', url: `/v1/messages/${MESSAGE_A}` },
      { method: 'POST', url: '/v1/messages' },
      { method: 'POST', url: `/v1/messages/${MESSAGE_A}/schedule` },
    ];
    const seen: number[] = [];
    for (const request of sequence) seen.push((await app.inject(request)).statusCode);

    expect(seen).toEqual([401, 401, 401, 429]);
  });

  it('counts unknown routes too, so probing for paths cannot run free', async () => {
    const app = await build();

    expect(await statuses(app, 5, { method: 'GET', url: '/v1/not-a-route' })).toEqual([
      404, 404, 404, 429, 429,
    ]);
    expect((await app.inject({ method: 'GET', url: '/v1/not-a-route' })).json().error.code).toBe(
      'RATE_LIMITED',
    );
  });

  it('keeps a separate budget per client address', async () => {
    const app = await build();
    const asClient = (address: string): TestRequest => ({
      method: 'GET',
      url: '/v1/messages',
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
    expect(await statuses(app, 3, { method: 'GET', url: '/v1/messages' })).toEqual([401, 401, 401]);
    // ...and once it is spent, the probes still answer.
    expect((await app.inject({ method: 'GET', url: '/v1/messages' })).statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(probe.statusCode);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  it('holds sending to its own stricter limit, shared across messages and separate from the global one', async () => {
    const app = await build({ RATE_LIMIT_MAX: '1000' });

    // Alternating between two messages: the budget belongs to the route, not to one URL.
    const seen: number[] = [];
    for (let attempt = 0; attempt < SEND_LIMIT + 2; attempt += 1) {
      const id = attempt % 2 === 0 ? MESSAGE_A : MESSAGE_B;
      seen.push((await app.inject({ method: 'POST', url: `/v1/messages/${id}/send` })).statusCode);
    }
    expect(seen).toEqual([...Array(SEND_LIMIT).fill(401), 429, 429]);

    const throttled = await app.inject({ method: 'POST', url: `/v1/messages/${MESSAGE_A}/send` });
    expect(throttled.json().error.code).toBe('RATE_LIMITED');
    expect(throttled.headers['x-ratelimit-limit']).toBe(String(SEND_LIMIT));

    // Only sending is closed: the rest of the API is well inside the global budget.
    expect((await app.inject({ method: 'GET', url: '/v1/messages' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: `/v1/messages/${MESSAGE_A}/schedule` })).statusCode,
    ).toBe(401);
  });
});
