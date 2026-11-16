import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import type { Database } from '@atlas/db';
import { createBroker, type MemoryBroker } from '@atlas/messaging';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadOutreachServiceEnv } from '../src/env.js';
import type { OutreachTransport } from '../src/lib/transport.js';
import { stubJwksAndCreateSigner, SUPABASE_URL } from './support.js';

// No database here on purpose. The `db` handed to the app throws on any use, so a request that
// gets a clean 503 provably never read, claimed or wrote anything. The DB-backed counterpart
// (rows unchanged afterwards) is in outreach-flow.test.ts.
const SEND_LIMIT = 20;
const SOME_MESSAGE = randomUUID();

function untouchableDb(touched: string[]): Database {
  return new Proxy({} as Database, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error(`the database must not be used (${String(property)})`);
    },
  });
}

interface Harness {
  app: FastifyInstance;
  broker: MemoryBroker;
  touched: string[];
  transportSend: ReturnType<typeof vi.fn<OutreachTransport['send']>>;
  token: string;
}

const opened: FastifyInstance[] = [];
let sign: Awaited<ReturnType<typeof stubJwksAndCreateSigner>>;

beforeAll(async () => {
  sign = await stubJwksAndCreateSigner();
});

afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
});

async function build(envOverrides: Record<string, string> = {}): Promise<Harness> {
  const env = loadOutreachServiceEnv({
    DATABASE_URL: 'postgres://atlas:atlas@127.0.0.1:1/never_used',
    PORT: '4007',
    SUPABASE_URL,
    LOG_LEVEL: 'fatal',
    ...envOverrides,
  });
  const touched: string[] = [];
  const broker = createBroker({ driver: 'memory', logger: createSilentLogger() }) as MemoryBroker;
  const transportSend = vi.fn<OutreachTransport['send']>(async () => undefined);
  const app = buildApp({
    db: untouchableDb(touched),
    sql: {} as never,
    env,
    logger: createSilentLogger(),
    broker,
    transport: { send: transportSend },
    tokenVerifier: createTokenVerifierConfig(env),
  });
  opened.push(app);
  await app.ready();
  const userId = randomUUID();
  const token = await sign({ sub: userId, sid: randomUUID(), org: null, role: null, email: `${userId}@example.com` });
  return { app, broker, touched, transportSend, token };
}

const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe('delivery disabled (the default)', () => {
  it('rejects send with a clear 503 before reading, claiming or sending anything, and publishes no event', async () => {
    const { app, broker, touched, transportSend, token } = await build();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/messages/${SOME_MESSAGE}/send`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      message: expect.stringContaining('does not deliver messages'),
      details: { reason: 'delivery_disabled', alternative: 'POST /v1/messages/:id/mark-sent' },
    });
    expect(touched).toEqual([]);
    expect(transportSend).not.toHaveBeenCalled();
    expect(broker.published).toEqual([]);
  });

  it('rejects schedule the same way, whatever the body says', async () => {
    const { app, broker, touched, token } = await build();

    for (const payload of [{ scheduled_for: inOneHour() }, { scheduled_for: 'not a date' }, {}]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/messages/${SOME_MESSAGE}/schedule`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.details.reason).toBe('delivery_disabled');
    }
    expect(touched).toEqual([]);
    expect(broker.published).toEqual([]);
  });

  it('still answers an anonymous caller with 401, so the refusal tells them nothing', async () => {
    const { app, touched } = await build();

    for (const url of [`/v1/messages/${SOME_MESSAGE}/send`, `/v1/messages/${SOME_MESSAGE}/schedule`]) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode).toBe(401);
    }
    expect(touched).toEqual([]);
  });

  it('treats an explicit false the same as the default', async () => {
    const { app, token } = await build({ OUTREACH_DELIVERY_ENABLED: 'false' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/messages/${SOME_MESSAGE}/send`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it('does not lift the stricter send limit: the 21st attempt in a minute is a 429, not another 503', async () => {
    const { app, token } = await build({ RATE_LIMIT_MAX: '1000' });

    const seen: number[] = [];
    for (let attempt = 0; attempt < SEND_LIMIT + 2; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/messages/${SOME_MESSAGE}/send`,
        headers: { authorization: `Bearer ${token}` },
      });
      seen.push(res.statusCode);
    }
    expect(seen).toEqual([...Array(SEND_LIMIT).fill(503), 429, 429]);
  });

  it('applies the global limit to schedule even though it only answers 503', async () => {
    const { app, token } = await build({ RATE_LIMIT_MAX: '3' });

    const seen: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/messages/${SOME_MESSAGE}/schedule`,
        headers: { authorization: `Bearer ${token}` },
        payload: { scheduled_for: inOneHour() },
      });
      seen.push(res.statusCode);
    }
    expect(seen).toEqual([503, 503, 503, 429, 429]);
  });
});

describe('delivery enabled', () => {
  it('lets send and schedule through to their handlers (which then need the database)', async () => {
    const { app, touched, token } = await build({ OUTREACH_DELIVERY_ENABLED: 'true' });

    for (const [url, payload] of [
      [`/v1/messages/${SOME_MESSAGE}/send`, undefined],
      [`/v1/messages/${SOME_MESSAGE}/schedule`, { scheduled_for: inOneHour() }],
    ] as const) {
      const before = touched.length;
      const res = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });
      // The stand-in database throws, so reaching it surfaces as a 500, never as the 503 refusal.
      expect(res.statusCode).toBe(500);
      expect(touched.length).toBeGreaterThan(before);
    }
  });
});
