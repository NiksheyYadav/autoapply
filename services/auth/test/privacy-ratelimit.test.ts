import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, type DatabaseHandle } from '@atlas/db';
import { createLocalDriver } from '@atlas/storage';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadAuthServiceEnv } from '../src/env.js';

const SUPABASE_URL = 'https://test-project.supabase.co';
// Nothing listens on port 1. Everything below is turned away (401), rejected as invalid input (400)
// or throttled (429) before it could reach the database, which is itself part of what is checked.
const UNREACHABLE_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:1/atlas_auth_privacy_ratelimit';

const opened: Array<{ app: FastifyInstance; handle: DatabaseHandle }> = [];
let signToken: (userId: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  signToken = async (userId) =>
    new SignJWT({ session_id: randomUUID(), email: `${userId}@example.test`, app_metadata: { org_id: null, role: null } })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(userId)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(privateKey);
  return () => vi.unstubAllGlobals();
});

async function build(envOverrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const env = loadAuthServiceEnv({
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    PORT: '4001',
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
    tokenVerifier: createTokenVerifierConfig(env),
    storage: createLocalDriver({ root: join(tmpdir(), 'atlas-auth-privacy-ratelimit') }),
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

type TestRequest = { method: 'GET' | 'DELETE'; url: string; headers?: Record<string, string>; payload?: unknown };

async function statuses(app: FastifyInstance, count: number, request: TestRequest): Promise<number[]> {
  const out: number[] = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    out.push((await app.inject(request as never)).statusCode);
  }
  return out;
}

const EXPORT: TestRequest = { method: 'GET', url: '/v1/auth/me/export' };
const DELETE: TestRequest = { method: 'DELETE', url: '/v1/auth/me', payload: { confirm: 'DELETE' } };

describe('account privacy rate limits', () => {
  it('ships defaults where deleting an account is allowed fewer attempts than exporting one', () => {
    const env = loadAuthServiceEnv({ DATABASE_URL: UNREACHABLE_DATABASE_URL, PORT: '4001', SUPABASE_URL });

    expect(env.PRIVACY_DELETE_RATE_LIMIT_MAX).toBeLessThan(env.PRIVACY_EXPORT_RATE_LIMIT_MAX);
    expect(env.PRIVACY_DELETE_RATE_LIMIT_MAX).toBeLessThan(env.RATE_LIMIT_MAX);
    expect(env.PRIVACY_RATE_LIMIT_WINDOW).toBe('1 hour');
  });

  it('throttles the export route on its own budget and answers 429 RATE_LIMITED', async () => {
    const app = await build({ PRIVACY_EXPORT_RATE_LIMIT_MAX: '2' });

    expect(await statuses(app, 4, EXPORT)).toEqual([401, 401, 429, 429]);

    const throttled = await app.inject(EXPORT as never);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error).toMatchObject({ code: 'RATE_LIMITED', request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(throttled.headers['x-ratelimit-limit']).toBe('2');
    expect(throttled.headers['x-ratelimit-remaining']).toBe('0');
    // The window is the hour that was configured, not the general one-minute window.
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(60);
    expect(Number(throttled.headers['retry-after'])).toBeLessThanOrEqual(3600);
  });

  it('throttles the delete route on a smaller budget, counting every attempt including rejected ones', async () => {
    const app = await build({ PRIVACY_DELETE_RATE_LIMIT_MAX: '2' });
    const token = await signToken(randomUUID());
    const authed = (payload: unknown): TestRequest => ({
      method: 'DELETE',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

    // 400s: a signed-in caller who has not typed the confirmation gets a validation error, still
    // before the database is touched, and still spends budget.
    expect(await statuses(app, 3, authed({ confirm: 'nope' }))).toEqual([400, 400, 429]);
    // And the budget is the route's, so a fresh client address has its own.
    expect(
      await statuses(app, 2, { ...DELETE, headers: { 'x-forwarded-for': '203.0.113.77' } }),
    ).toEqual([401, 401]);
  });

  it('keeps the two privacy budgets and the general budget separate from one another', async () => {
    const app = await build({
      RATE_LIMIT_MAX: '3',
      PRIVACY_EXPORT_RATE_LIMIT_MAX: '1',
      PRIVACY_DELETE_RATE_LIMIT_MAX: '1',
    });

    // Spend the export budget...
    expect(await statuses(app, 2, EXPORT)).toEqual([401, 429]);
    // ...the delete budget is untouched...
    expect((await app.inject(DELETE as never)).statusCode).toBe(401);
    expect((await app.inject(DELETE as never)).statusCode).toBe(429);
    // ...and so is the general one used by every other route.
    expect(await statuses(app, 3, { method: 'GET', url: '/v1/auth/me' })).toEqual([401, 401, 401]);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(429);
  });

  it('does not let the general budget starve the privacy routes either', async () => {
    const app = await build({ RATE_LIMIT_MAX: '2', PRIVACY_EXPORT_RATE_LIMIT_MAX: '5' });

    expect(await statuses(app, 3, { method: 'GET', url: '/v1/auth/me' })).toEqual([401, 401, 429]);
    expect(await statuses(app, 2, EXPORT)).toEqual([401, 401]);
  });

  it('answers a browser preflight for DELETE with the Authorization header, without spending any budget', async () => {
    const app = await build({
      CORS_ORIGINS: 'https://app.example.test',
      PRIVACY_DELETE_RATE_LIMIT_MAX: '1',
      PRIVACY_EXPORT_RATE_LIMIT_MAX: '1',
    });
    const preflight = (method: string) =>
      app.inject({
        method: 'OPTIONS',
        url: method === 'DELETE' ? '/v1/auth/me' : '/v1/auth/me/export',
        headers: {
          origin: 'https://app.example.test',
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization,content-type',
        },
      });

    for (const method of ['DELETE', 'GET']) {
      const res = await preflight(method);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.test');
      expect(res.headers['access-control-allow-methods']).toContain(method);
      expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('authorization');
    }
    // Several preflights later, the real requests still have their one allowed attempt.
    await preflight('DELETE');
    await preflight('DELETE');
    expect((await app.inject(DELETE as never)).statusCode).toBe(401);
    expect((await app.inject(DELETE as never)).statusCode).toBe(429);
  });
});

describe('account privacy routes without a database', () => {
  it('require a bearer token before anything else, including on a malformed confirmation', async () => {
    const app = await build();

    for (const request of [EXPORT, DELETE, { ...DELETE, payload: { confirm: 'wrong' } }]) {
      const res = await app.inject(request as never);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    }
  });
});
