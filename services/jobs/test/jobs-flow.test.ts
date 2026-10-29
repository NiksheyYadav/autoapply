import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createBroker } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadJobsServiceEnv } from '../src/env.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const SUPABASE_URL = 'https://test-project.supabase.co';

let signTestToken: (claims: { sub: string; sid: string; org: string | null; role: string | null; email: string }) => Promise<string>;

// createRemoteJWKSet fetches over HTTP — stub it to serve a locally
// generated key instead of hitting a real Supabase project.
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

describe.skipIf(!testDatabaseUrl)('jobs-service HTTP flow', () => {
  let app: FastifyInstance;
  // Same service, but booted with no PLATFORM_ADMIN_USER_IDS at all.
  let appWithoutAllowlist: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let adminToken: string;
  let memberToken: string;
  let orgOwnerToken: string;
  let orgAdminToken: string;
  const adminUserId = randomUUID();
  const memberUserId = randomUUID();
  const orgOwnerUserId = randomUUID();
  const orgAdminUserId = randomUUID();
  const orgId = randomUUID();
  const companyName = `Test Co ${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await stubJwks();
    // Platform admin is a server-side allowlist of user ids, not an org role.
    const env = loadJobsServiceEnv({
      DATABASE_URL: testDatabaseUrl,
      PORT: '4003',
      SUPABASE_URL,
      PLATFORM_ADMIN_USER_IDS: ` ${adminUserId.toUpperCase()} , `,
    });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    const broker = createBroker({ driver: 'memory', logger: createSilentLogger() });
    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      broker,
      tokenVerifier: createTokenVerifierConfig(env),
    });
    await app.ready();

    const envWithoutAllowlist = loadJobsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4003', SUPABASE_URL });
    expect(envWithoutAllowlist.PLATFORM_ADMIN_USER_IDS).toBe('');
    appWithoutAllowlist = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env: envWithoutAllowlist,
      logger: createSilentLogger(),
      broker,
      tokenVerifier: createTokenVerifierConfig(envWithoutAllowlist),
    });
    await appWithoutAllowlist.ready();

    // The platform admin deliberately carries no org role: being on the allowlist is what counts.
    adminToken = await signTestToken({ sub: adminUserId, sid: randomUUID(), org: null, role: null, email: 'admin@example.com' });
    memberToken = await signTestToken({ sub: memberUserId, sid: randomUUID(), org: null, role: 'member', email: 'member@example.com' });
    orgOwnerToken = await signTestToken({ sub: orgOwnerUserId, sid: randomUUID(), org: orgId, role: 'owner', email: 'owner@example.com' });
    orgAdminToken = await signTestToken({ sub: orgAdminUserId, sid: randomUUID(), org: orgId, role: 'admin', email: 'orgadmin@example.com' });
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.name, companyName));
    await app.close();
    await appWithoutAllowlist.close();
    await dbHandle.close();
  });

  it('rejects ingest from a non-admin role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/ingest',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { postings: [{ source: 'manual', external_id: null, title: 'Engineer', company_name: companyName }] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects ingest from an org owner who is not on the platform-admin allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/ingest',
      headers: { authorization: `Bearer ${orgOwnerToken}` },
      payload: { postings: [{ source: 'manual', external_id: null, title: 'Owner Injected Job', company_name: companyName }] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('rejects ingest from an org admin who is not on the platform-admin allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/ingest',
      headers: { authorization: `Bearer ${orgAdminToken}` },
      payload: { postings: [{ source: 'manual', external_id: null, title: 'Admin Injected Job', company_name: companyName }] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('writes nothing to the catalog when an unauthorized caller is rejected', async () => {
    const rows = await dbHandle.db.select().from(schema.jobs).where(eq(schema.jobs.title, 'Owner Injected Job'));
    expect(rows).toHaveLength(0);
    const adminRows = await dbHandle.db.select().from(schema.jobs).where(eq(schema.jobs.title, 'Admin Injected Job'));
    expect(adminRows).toHaveLength(0);
  });

  it('fails closed: with no allowlist configured, nobody can ingest (not even the former admin)', async () => {
    for (const token of [adminToken, orgOwnerToken, orgAdminToken]) {
      const res = await appWithoutAllowlist.inject({
        method: 'POST',
        url: '/v1/jobs/ingest',
        headers: { authorization: `Bearer ${token}` },
        payload: { postings: [{ source: 'manual', external_id: null, title: 'No Allowlist Job', company_name: companyName }] },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('ingests a posting, dedupes an identical re-ingest, and serves it back', async () => {
    const posting = {
      source: 'manual',
      external_id: 'ext-1',
      title: 'Staff Backend Engineer',
      company_name: companyName,
      description: 'Build and operate distributed systems at scale for our platform.',
      remote_type: 'Fully Remote',
      employment_type: 'Full-time',
      apply_url: 'https://example.com/apply/1',
      location: 'Remote',
    };

    const firstRes = await app.inject({
      method: 'POST',
      url: '/v1/jobs/ingest',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { postings: [posting] },
    });
    expect(firstRes.statusCode).toBe(200);
    const firstReport = firstRes.json();
    expect(firstReport.inserted).toBe(1);
    expect(firstReport.duplicates).toBe(0);

    const secondRes = await app.inject({
      method: 'POST',
      url: '/v1/jobs/ingest',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { postings: [posting] },
    });
    const secondReport = secondRes.json();
    expect(secondReport.inserted).toBe(0);
    expect(secondReport.duplicates).toBe(1);

    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const found = listRes.json().items.find((j: { title: string }) => j.title === 'Staff Backend Engineer');
    expect(found).toBeDefined();
    // The list names the employer, so a client does not need a second lookup per job.
    expect(found.company_name).toBe(companyName);

    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${found.job_id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().job.remote_type).toBe('remote');
    expect(getRes.json().job.company_name).toBe(companyName);
    expect(getRes.json().job.skills).toEqual(expect.arrayContaining([]));
  });

  it('does not store non-http(s) apply URLs or company websites (stored-XSS vector)', async () => {
    // A fresh company, so its website is set by this very ingest.
    const xssCompany = `${companyName} Xss`;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/ingest',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          postings: [
            {
              source: 'manual',
              external_id: 'xss-1',
              title: 'Platform Engineer With A Hostile Link',
              company_name: xssCompany,
              description: 'Operate the platform and keep the lights on for every team, all day long.',
              apply_url: 'javascript:alert(document.cookie)',
              company_website: 'javascript:alert(1)',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().inserted).toBe(1);

      const [company] = await dbHandle.db.select().from(schema.companies).where(eq(schema.companies.name, xssCompany));
      expect(company).toBeDefined();
      expect(company!.website).toBeNull();

      const [job] = await dbHandle.db.select().from(schema.jobs).where(eq(schema.jobs.companyId, company!.companyId));
      expect(job).toBeDefined();
      expect(job!.applyUrl).toBeNull();
    } finally {
      await dbHandle.db.delete(schema.companies).where(eq(schema.companies.name, xssCompany));
    }
  });

  it('keeps a legitimate https company website', async () => {
    const siteCompany = `${companyName} Web`;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/ingest',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          postings: [
            {
              source: 'manual',
              external_id: 'web-1',
              title: 'Site Reliability Engineer',
              company_name: siteCompany,
              company_website: 'https://example.com/about',
              apply_url: 'https://example.com/apply/web-1',
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const [company] = await dbHandle.db.select().from(schema.companies).where(eq(schema.companies.name, siteCompany));
      expect(company!.website).toBe('https://example.com/about');
    } finally {
      await dbHandle.db.delete(schema.companies).where(eq(schema.companies.name, siteCompany));
    }
  });

  it('reports a rejected posting with a generic reason, never driver or SQL detail', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/ingest',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        postings: [
          // NUL bytes are valid JSON/zod strings but Postgres refuses to store them.
          { source: 'manual', external_id: 'bad-1', title: 'Broken\u0000Posting', company_name: companyName, description: 'SECRET-DESCRIPTION-TEXT' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.rejected).toBe(1);
    expect(report.inserted).toBe(0);
    expect(report.errors).toEqual(['postings[0]: could not be processed']);
    expect(res.body).not.toMatch(/insert into|params|Failed query|SECRET-DESCRIPTION-TEXT|invalid byte sequence|violates/i);
  });

  it('400s a malformed job id instead of letting the uuid cast 500', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/jobs/not-a-uuid',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('404s a well-formed job id that does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${randomUUID()}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('JOB_NOT_FOUND');
  });

  it('403s recommendations for a mismatched user_id from a non-admin caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/recommendations?user_id=${adminUserId}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns an empty recommendations page for your own user_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/recommendations?user_id=${memberUserId}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('exposes Prometheus metrics, including counts for requests made during this suite', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('service="jobs-service"');
    expect(res.body).toContain('http_requests_total');
  });
});
