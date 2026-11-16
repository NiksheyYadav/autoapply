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
// Nothing listens on port 1; the drain route never reaches the database.
const UNREACHABLE_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:1/atlas_drain_route';

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
      return { processed: 2, failed: 1, dead: 0, purged: 3 };
    },
  };
}

const opened: Array<{ app: FastifyInstance; handle: DatabaseHandle }> = [];

function build(
  broker: DrainableBroker | ReturnType<typeof createBroker>,
  envOverrides: Record<string, string | undefined> = { CRON_SECRET: SECRET },
): FastifyInstance {
  const env = loadLearningServiceEnv({
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    PORT: '4008',
    SUPABASE_URL,
    LOG_LEVEL: 'fatal',
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
  return app;
}

afterEach(async () => {
  for (const { app, handle } of opened.splice(0)) {
    await app.close();
    await handle.close();
  }
});

describe('learning-service /internal/drain', () => {
  it('answers 503 and never drains when CRON_SECRET is not configured', async () => {
    const broker = stubBroker();
    const app = build(broker, {});

    for (const authorization of [undefined, `Bearer ${SECRET}`]) {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/drain',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
    }
    expect(broker.calls).toHaveLength(0);
  });

  it('answers 401 without a bearer token', async () => {
    const broker = stubBroker();
    const app = build(broker);

    const response = await app.inject({ method: 'POST', url: '/internal/drain' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    expect(broker.calls).toHaveLength(0);
  });

  it.each([
    ['a wrong secret', 'Bearer not-the-secret'],
    ['a truncated secret', `Bearer ${SECRET.slice(0, -1)}`],
    ['an extended secret', `Bearer ${SECRET}0`],
    ['another auth scheme', `Basic ${SECRET}`],
    ['a bare secret', SECRET],
  ])('answers 401 for %s', async (_label, authorization) => {
    const broker = stubBroker();
    const app = build(broker);

    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({
        method,
        url: '/internal/drain',
        headers: { authorization },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(broker.calls).toHaveLength(0);
  });

  it('drains and returns the counts on POST and on the GET Vercel Cron actually sends', async () => {
    const broker = stubBroker();
    const app = build(broker);

    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({
        method,
        url: '/internal/drain',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ processed: 2, failed: 1, dead: 0, purged: 3 });
      expect(typeof response.json().duration_ms).toBe('number');
    }
    expect(broker.calls).toEqual([
      { budgetMs: 20_000, limit: undefined },
      { budgetMs: 20_000, limit: undefined },
    ]);
  });

  it('serves the same protected handler at the service-scoped path a Vercel rewrite can target', async () => {
    const broker = stubBroker();
    const app = build(broker);
    const path = '/internal/learning/drain';

    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: path })).statusCode).toBe(401);
    expect(broker.calls).toHaveLength(0);

    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({
        method,
        url: path,
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ processed: 2, failed: 1, dead: 0, purged: 3 });
    }
    expect(broker.calls).toHaveLength(2);
  });

  it('passes a validated limit and time budget through to the broker', async () => {
    const broker = stubBroker();
    const app = build(broker);

    const response = await app.inject({
      method: 'POST',
      url: '/internal/drain?limit=7&budget_ms=1500',
      headers: { authorization: `Bearer ${SECRET}` },
    });

    expect(response.statusCode).toBe(200);
    expect(broker.calls).toEqual([{ budgetMs: 1500, limit: 7 }]);
  });

  it('rejects a budget that would outlive the function, and checks credentials before the query', async () => {
    const broker = stubBroker();
    const app = build(broker);

    const tooLong = await app.inject({
      method: 'POST',
      url: '/internal/drain?budget_ms=60000',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(tooLong.statusCode).toBe(400);

    const badEverything = await app.inject({
      method: 'POST',
      url: '/internal/drain?limit=0',
      headers: { authorization: 'Bearer nope' },
    });
    expect(badEverything.statusCode).toBe(401);
    expect(broker.calls).toHaveLength(0);
  });

  it('reports 409 when the configured driver has nothing to drain', async () => {
    const app = build(createBroker({ driver: 'memory', logger: createSilentLogger() }));

    const response = await app.inject({
      method: 'POST',
      url: '/internal/drain',
      headers: { authorization: `Bearer ${SECRET}` },
    });

    expect(response.statusCode).toBe(409);
  });

  it('refuses to boot with a CRON_SECRET too short to be a secret', () => {
    expect(() =>
      loadLearningServiceEnv({
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        PORT: '4008',
        SUPABASE_URL,
        CRON_SECRET: 'short',
      }),
    ).toThrow(/CRON_SECRET/);
  });
});
