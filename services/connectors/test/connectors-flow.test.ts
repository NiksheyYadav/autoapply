import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadConnectorsServiceEnv } from '../src/env.js';
import { createSecretStore } from '../src/lib/secret-store.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const JWT_SECRET = 'x'.repeat(32);

async function signTestToken(claims: { sub: string; sid: string; org: string | null; role: string | null; email: string }) {
  return new SignJWT({ sid: claims.sid, org: claims.org, role: claims.role, email: claims.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer('atlas')
    .setAudience('atlas-clients')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

describe.skipIf(!testDatabaseUrl)('connectors-service HTTP flow', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let secretsRoot: string;
  let token: string;
  let otherToken: string;
  const userId = randomUUID();
  const otherUserId = randomUUID();

  beforeAll(async () => {
    const env = loadConnectorsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4011', JWT_SECRET });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    secretsRoot = await mkdtemp(join(tmpdir(), 'atlas-connectors-test-'));
    const secretStore = createSecretStore({ driver: 'local', localRoot: secretsRoot });
    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      secretStore,
      tokenVerifier: { secret: new TextEncoder().encode(JWT_SECRET), issuer: 'atlas', audience: 'atlas-clients' },
    });
    await app.ready();

    await dbHandle.db.insert(schema.users).values([
      { userId, email: `connectors-flow-${userId}@example.com`, fullName: 'User', authProvider: 'password' },
      { userId: otherUserId, email: `connectors-flow-other-${otherUserId}@example.com`, fullName: 'Other User', authProvider: 'password' },
    ]);

    token = await signTestToken({ sub: userId, sid: randomUUID(), org: null, role: null, email: 'user@example.com' });
    otherToken = await signTestToken({ sub: otherUserId, sid: randomUUID(), org: null, role: null, email: 'other@example.com' });
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.connectorAccounts).where(eq(schema.connectorAccounts.userId, userId));
    await dbHandle.db.delete(schema.connectorAccounts).where(eq(schema.connectorAccounts.userId, otherUserId));
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, userId));
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, otherUserId));
    await app.close();
    await dbHandle.close();
    await rm(secretsRoot, { recursive: true, force: true });
  });

  it('lists every provider as disconnected before any connection exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/connectors', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers.every((p: { connected: boolean }) => p.connected === false)).toBe(true);
  });

  it('404s connecting an unknown provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/not-a-real-provider/connect',
      headers: { authorization: `Bearer ${token}` },
      payload: { external_account_id: 'board-1', credential: 'secret-token', consent: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires explicit consent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/greenhouse/connect',
      headers: { authorization: `Bearer ${token}` },
      payload: { external_account_id: 'board-1', credential: 'secret-token' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('connects a provider and never returns the credential', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/greenhouse/connect',
      headers: { authorization: `Bearer ${token}` },
      payload: { external_account_id: 'board-1', credential: 'secret-token', consent: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.connector.status).toBe('active');
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(body.connector.secret_ref).toBeUndefined();
  });

  it('reconnecting the same provider replaces the row instead of duplicating it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/greenhouse/connect',
      headers: { authorization: `Bearer ${token}` },
      payload: { external_account_id: 'board-1-renamed', credential: 'new-secret-token', consent: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connector.external_account_id).toBe('board-1-renamed');

    const rows = await dbHandle.db.select().from(schema.connectorAccounts).where(eq(schema.connectorAccounts.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('rejects a different user claiming the same external account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/greenhouse/connect',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { external_account_id: 'board-1-renamed', credential: 'someone-elses-token', consent: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it('disconnects a provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/greenhouse/disconnect',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connector.status).toBe('revoked');
  });

  it('404s disconnecting a provider that was never connected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connectors/lever/disconnect',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
