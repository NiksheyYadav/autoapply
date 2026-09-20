import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadAuthServiceEnv } from '../src/env.js';
import { createTokenConfig } from '../src/security/tokens.js';

/**
 * Every case here fails (or is designed to fail) before touching the
 * database, so — unlike auth-flow.test.ts — this suite never needs
 * ATLAS_TEST_DATABASE_URL. postgres.js connects lazily, so a placeholder
 * DATABASE_URL is safe as long as no route in these cases issues a query.
 */
describe('auth-service OAuth routes', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;

  beforeAll(async () => {
    const env = loadAuthServiceEnv({
      DATABASE_URL: 'postgres://placeholder:placeholder@localhost:5432/placeholder',
      PORT: '4001',
      JWT_SECRET: 'x'.repeat(32),
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      WEB_APP_URL: 'http://localhost:3000',
    });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      tokenConfig: createTokenConfig(env),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await dbHandle.close();
  });

  it('503s an unconfigured provider (microsoft has no client id/secret here)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/oauth/microsoft/start' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('OAUTH_PROVIDER_UNAVAILABLE');
  });

  it('503s an unknown provider name', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/oauth/bogus/start' });
    expect(res.statusCode).toBe(503);
  });

  it('redirects to the provider and sets a signed, httpOnly state cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/oauth/google/start' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('client_id')).toBe('test-google-client-id');
    expect(location.searchParams.get('redirect_uri')).toContain('/v1/auth/oauth/google/callback');
    expect(location.searchParams.get('state')).toBeTruthy();

    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain('atlas_oauth_state=');
    expect(cookieHeader).toContain('HttpOnly');
  });

  it('sends the callback back to login with an error hint when the provider reports denial', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/oauth/google/callback?error=access_denied' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('oauth_error')).toBe('denied');
  });

  it('rejects a callback with no state cookie at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/oauth/google/callback?code=abc&state=xyz' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('oauth_error')).toBe('state');
  });

  it('rejects a callback whose state query param does not match the signed cookie', async () => {
    const startRes = await app.inject({ method: 'GET', url: '/v1/auth/oauth/google/start' });
    const setCookie = startRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const stateCookie = (cookieHeader as string).split(';')[0];

    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/google/callback?code=abc&state=not-the-real-nonce',
      headers: { cookie: stateCookie },
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('oauth_error')).toBe('state');
  });
});
