import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBroker } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadJobsServiceEnv } from '../src/env.js';

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

describe.skipIf(!testDatabaseUrl)('jobs-service HTTP flow', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let adminToken: string;
  let memberToken: string;
  const adminUserId = randomUUID();
  const memberUserId = randomUUID();
  const companyName = `Test Co ${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const env = loadJobsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4003', JWT_SECRET });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    const broker = createBroker({ driver: 'memory', logger: createSilentLogger() });
    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      broker,
      tokenVerifier: { secret: new TextEncoder().encode(JWT_SECRET), issuer: 'atlas', audience: 'atlas-clients' },
    });
    await app.ready();

    adminToken = await signTestToken({ sub: adminUserId, sid: randomUUID(), org: null, role: 'admin', email: 'admin@example.com' });
    memberToken = await signTestToken({ sub: memberUserId, sid: randomUUID(), org: null, role: 'member', email: 'member@example.com' });
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.name, companyName));
    await app.close();
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

    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${found.job_id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().job.remote_type).toBe('remote');
    expect(getRes.json().job.skills).toEqual(expect.arrayContaining([]));
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
