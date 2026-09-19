import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadAuthServiceEnv } from '../src/env.js';
import { createTokenConfig } from '../src/security/tokens.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('auth-service HTTP flow', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  const email = `auth-flow-${randomUUID()}@example.com`;
  const password = 'correct-horse-battery-staple';

  beforeAll(async () => {
    const env = loadAuthServiceEnv({
      DATABASE_URL: testDatabaseUrl,
      PORT: '4001',
      JWT_SECRET: 'x'.repeat(32),
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
    await dbHandle.db.delete(schema.users).where(eq(schema.users.email, email));
    await app.close();
    await dbHandle.close();
  });

  it('registers, logs in, reads /me, rotates the refresh token, and logs out', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password, full_name: 'Ada Lovelace' },
    });
    expect(registerRes.statusCode).toBe(201);
    expect(registerRes.json().user.email).toBe(email);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(200);
    const { tokens } = loginRes.json();

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.email).toBe(email);

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refresh_token: tokens.refresh_token },
    });
    expect(refreshRes.statusCode).toBe(200);
    const refreshed = refreshRes.json();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    // The old refresh token was burned by rotation — reusing it must be rejected.
    const reuseRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refresh_token: tokens.refresh_token },
    });
    expect(reuseRes.statusCode).toBe(401);

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(logoutRes.statusCode).toBe(204);
  });

  it('rejects login with the wrong password without revealing why', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'totally-wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects duplicate registration for the same email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'another-long-password', full_name: 'Duplicate' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('reports healthy on /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
