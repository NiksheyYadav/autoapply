import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createBroker } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { jobBoardSourceSchema, listJobBoardSourcesResponseSchema } from '@atlas/types';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadJobsServiceEnv } from '../src/env.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const SUPABASE_URL = 'https://test-project.supabase.co';

type Claims = { sub: string; sid: string; org: string | null; role: string | null; email: string };
let signTestToken: (claims: Claims) => Promise<string>;

// createRemoteJWKSet fetches over HTTP: serve a locally generated key instead of a real project's.
async function stubJwks(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  signTestToken = async (claims) =>
    new SignJWT({ session_id: claims.sid, email: claims.email, app_metadata: { org_id: claims.org, role: claims.role } })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(claims.sub)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(privateKey);
}

describe.skipIf(!testDatabaseUrl)('jobs-service /v1/jobs/sources', () => {
  let app: FastifyInstance;
  let appWithoutAllowlist: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let adminToken: string;
  let memberToken: string;
  let orgOwnerToken: string;
  let orgAdminToken: string;
  const adminUserId = randomUUID();
  const orgId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const tokenFor = (suffix: string): string => `adm-${tag}-${suffix}`;

  beforeAll(async () => {
    await stubJwks();
    const env = loadJobsServiceEnv({
      DATABASE_URL: testDatabaseUrl,
      PORT: '4003',
      SUPABASE_URL,
      LOG_LEVEL: 'fatal',
      PLATFORM_ADMIN_USER_IDS: adminUserId,
    });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    const broker = createBroker({ driver: 'memory', logger: createSilentLogger() });
    const deps = { db: dbHandle.db, sql: dbHandle.sql, logger: createSilentLogger(), broker };
    app = buildApp({ ...deps, env, tokenVerifier: createTokenVerifierConfig(env) });
    await app.ready();

    const bareEnv = loadJobsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4003', SUPABASE_URL, LOG_LEVEL: 'fatal' });
    appWithoutAllowlist = buildApp({ ...deps, env: bareEnv, tokenVerifier: createTokenVerifierConfig(bareEnv) });
    await appWithoutAllowlist.ready();

    adminToken = await signTestToken({ sub: adminUserId, sid: randomUUID(), org: null, role: null, email: 'admin@example.com' });
    memberToken = await signTestToken({ sub: randomUUID(), sid: randomUUID(), org: null, role: 'member', email: 'member@example.com' });
    orgOwnerToken = await signTestToken({ sub: randomUUID(), sid: randomUUID(), org: orgId, role: 'owner', email: 'owner@example.com' });
    orgAdminToken = await signTestToken({ sub: randomUUID(), sid: randomUUID(), org: orgId, role: 'admin', email: 'orgadmin@example.com' });
  });

  afterAll(async () => {
    const mine = await dbHandle.db.select().from(schema.jobSources);
    const ids = mine.filter((row) => row.boardToken.startsWith(`adm-${tag}`)).map((row) => row.sourceId);
    if (ids.length > 0) await dbHandle.db.delete(schema.jobSources).where(inArray(schema.jobSources.sourceId, ids));
    await app.close();
    await appWithoutAllowlist.close();
    await dbHandle.close();
  });

  const as = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
  const post = (payload: unknown, token: string = adminToken, target: FastifyInstance = app) =>
    target.inject({ method: 'POST', url: '/v1/jobs/sources', headers: as(token), payload: payload as object });
  const rowsFor = async (boardToken: string) =>
    dbHandle.db.select().from(schema.jobSources).where(eq(schema.jobSources.boardToken, boardToken));

  describe('who may use it', () => {
    it('requires authentication', async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/jobs/sources' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/v1/jobs/sources', payload: {} })).statusCode).toBe(401);
    });

    it('refuses members and org admins/owners: an org role carries no platform trust', async () => {
      const boardToken = tokenFor('denied');
      for (const token of [memberToken, orgOwnerToken, orgAdminToken]) {
        const listed = await app.inject({ method: 'GET', url: '/v1/jobs/sources', headers: as(token) });
        expect(listed.statusCode).toBe(403);
        expect(listed.json().error.code).toBe('FORBIDDEN');

        const added = await post({ provider: 'lever', board_token: boardToken, company_name: 'Denied Co' }, token);
        expect(added.statusCode).toBe(403);
      }
      expect(await rowsFor(boardToken)).toHaveLength(0);
    });

    it('fails closed: with no allowlist configured, nobody can list or manage sources', async () => {
      const boardToken = tokenFor('closed');
      for (const token of [adminToken, orgOwnerToken, orgAdminToken]) {
        expect((await appWithoutAllowlist.inject({ method: 'GET', url: '/v1/jobs/sources', headers: as(token) })).statusCode).toBe(403);
        expect((await post({ provider: 'lever', board_token: boardToken, company_name: 'Closed Co' }, token, appWithoutAllowlist)).statusCode).toBe(403);
      }
      expect(await rowsFor(boardToken)).toHaveLength(0);
    });

    it('is not shadowed by the /v1/jobs/:jobId route', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/jobs/sources', headers: as(adminToken) });
      expect(response.statusCode).toBe(200);
      expect(listJobBoardSourcesResponseSchema.safeParse(response.json()).success).toBe(true);
    });
  });

  describe('managing sources', () => {
    it('adds a source (201), updates it in place (200), and enables/disables it', async () => {
      const boardToken = tokenFor('manage');

      const created = await post({ provider: 'greenhouse', board_token: boardToken, company_name: '  Manage Co  ' });
      expect(created.statusCode).toBe(201);
      const body = jobBoardSourceSchema.parse(created.json());
      expect(body).toMatchObject({
        provider: 'greenhouse',
        board_token: boardToken,
        company_name: 'Manage Co',
        enabled: true,
        last_fetched_at: null,
        last_status: null,
        last_error: null,
        last_job_count: null,
      });

      // Upserting with no `enabled` renames and keeps the state.
      const renamed = await post({ provider: 'greenhouse', board_token: boardToken, company_name: 'Manage Company' });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ source_id: body.source_id, company_name: 'Manage Company', enabled: true });

      const disabled = await post({ provider: 'greenhouse', board_token: boardToken, company_name: 'Manage Company', enabled: false });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({ source_id: body.source_id, enabled: false });

      const stillDisabled = await post({ provider: 'greenhouse', board_token: boardToken, company_name: 'Manage Company Ltd' });
      expect(stillDisabled.json()).toMatchObject({ enabled: false, company_name: 'Manage Company Ltd' });

      const enabled = await post({ provider: 'greenhouse', board_token: boardToken, company_name: 'Manage Company Ltd', enabled: true });
      expect(enabled.json()).toMatchObject({ enabled: true });

      expect(await rowsFor(boardToken)).toHaveLength(1);
    });

    it('can start a source disabled', async () => {
      const response = await post({ provider: 'ashby', board_token: tokenFor('off'), company_name: 'Off Co', enabled: false });
      expect(response.statusCode).toBe(201);
      expect(response.json().enabled).toBe(false);
    });

    it('keeps one source per provider and token, but the same token may exist under another provider', async () => {
      const boardToken = tokenFor('multi');
      expect((await post({ provider: 'lever', board_token: boardToken, company_name: 'Multi Lever' })).statusCode).toBe(201);
      expect((await post({ provider: 'ashby', board_token: boardToken, company_name: 'Multi Ashby' })).statusCode).toBe(201);
      expect((await post({ provider: 'lever', board_token: boardToken, company_name: 'Multi Lever' })).statusCode).toBe(200);
      expect(await rowsFor(boardToken)).toHaveLength(2);
    });

    it('lists the stored sources with their status columns', async () => {
      const boardToken = tokenFor('listed');
      await post({ provider: 'lever', board_token: boardToken, company_name: 'Listed Co' });
      await dbHandle.db
        .update(schema.jobSources)
        .set({ lastStatus: 'partial', lastError: '2 posting(s) could not be stored', lastJobCount: 40, lastFetchedAt: new Date().toISOString() })
        .where(eq(schema.jobSources.boardToken, boardToken));

      const response = await app.inject({ method: 'GET', url: '/v1/jobs/sources', headers: as(adminToken) });
      expect(response.statusCode).toBe(200);
      const parsed = listJobBoardSourcesResponseSchema.parse(response.json());
      const mine = parsed.items.find((item) => item.board_token === boardToken);
      expect(mine).toMatchObject({
        provider: 'lever',
        company_name: 'Listed Co',
        enabled: true,
        last_status: 'partial',
        last_error: '2 posting(s) could not be stored',
        last_job_count: 40,
      });
      expect(mine?.last_fetched_at).toEqual(expect.any(String));
    });

    it('refuses two boards of one provider under one company name, and leaves the first alone', async () => {
      const first = await post({ provider: 'lever', board_token: tokenFor('clash-a'), company_name: `Clash ${tag} Inc` });
      expect(first.statusCode).toBe(201);

      // Same name once case and the company suffix are normalized away.
      const second = await post({ provider: 'lever', board_token: tokenFor('clash-b'), company_name: `clash ${tag}` });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('CONFLICT');
      expect(await rowsFor(tokenFor('clash-b'))).toHaveLength(0);

      // A different provider is a different sweep scope, so it is allowed; so is re-saving the first board.
      expect((await post({ provider: 'ashby', board_token: tokenFor('clash-c'), company_name: `Clash ${tag}` })).statusCode).toBe(201);
      expect((await post({ provider: 'lever', board_token: tokenFor('clash-a'), company_name: `Clash ${tag} Inc` })).statusCode).toBe(200);
    });
  });

  describe('validation', () => {
    it.each([
      ['an unknown provider', { provider: 'workday', board_token: 'ok', company_name: 'Co' }],
      ['a missing provider', { board_token: 'ok', company_name: 'Co' }],
      ['a missing token', { provider: 'lever', company_name: 'Co' }],
      ['a missing company name', { provider: 'lever', board_token: 'ok' }],
      ['a blank company name', { provider: 'lever', board_token: 'ok', company_name: '   ' }],
      ['an overlong company name', { provider: 'lever', board_token: 'ok', company_name: 'x'.repeat(301) }],
      ['a non-boolean enabled', { provider: 'lever', board_token: 'ok', company_name: 'Co', enabled: 'yes' }],
      ['a path-traversal token', { provider: 'lever', board_token: '../admin', company_name: 'Co' }],
      ['a hostname as the token', { provider: 'greenhouse', board_token: 'evil.example.com', company_name: 'Co' }],
      ['a token with userinfo', { provider: 'ashby', board_token: 'a@evil.example', company_name: 'Co' }],
      ['a token with a query string', { provider: 'lever', board_token: 'a?b=1', company_name: 'Co' }],
      ['an overlong token', { provider: 'lever', board_token: 'a'.repeat(101), company_name: 'Co' }],
      ['an array body', [{ provider: 'lever', board_token: 'ok', company_name: 'Co' }]],
    ])('rejects %s with 400 and stores nothing', async (_label, payload) => {
      const response = await post(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      // Other suites write to this table concurrently, so look for this payload's own token.
      const token = (payload as { board_token?: unknown }).board_token;
      if (typeof token === 'string') expect(await rowsFor(token)).toHaveLength(0);
    });
  });
});
