import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBroker } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadApplicationsServiceEnv } from '../src/env.js';

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

describe.skipIf(!testDatabaseUrl)('applications-service HTTP flow', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let token: string;
  let otherToken: string;
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const email = `applications-flow-${userId}@example.com`;
  const otherEmail = `applications-flow-${otherUserId}@example.com`;
  const companyName = `Applications Test Co ${randomUUID().slice(0, 8)}`;
  let companyId: string;
  let jobId: string;
  let secondJobId: string;
  let resumeId: string;

  beforeAll(async () => {
    const env = loadApplicationsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4005', JWT_SECRET });
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

    await dbHandle.db.insert(schema.users).values([
      { userId, email, fullName: 'Applications Flow Test User', authProvider: 'password' },
      { userId: otherUserId, email: otherEmail, fullName: 'Someone Else', authProvider: 'password' },
    ]);
    const [company] = await dbHandle.db
      .insert(schema.companies)
      .values({ name: companyName, normalizedName: companyName.toLowerCase() })
      .returning();
    companyId = company!.companyId;

    const [job] = await dbHandle.db
      .insert(schema.jobs)
      .values({
        companyId,
        title: 'Backend Engineer',
        source: 'manual',
        jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        isActive: true,
      })
      .returning();
    jobId = job!.jobId;

    const [secondJob] = await dbHandle.db
      .insert(schema.jobs)
      .values({
        companyId,
        title: 'Frontend Engineer',
        source: 'manual',
        jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        isActive: true,
      })
      .returning();
    secondJobId = secondJob!.jobId;

    const [resume] = await dbHandle.db
      .insert(schema.resumes)
      .values({
        userId,
        storageUrl: `resumes/${userId}/seed`,
        originalFilename: 'resume.txt',
        contentType: 'text/plain',
        byteSize: 10,
        contentHash: randomUUID(),
        status: 'parsed',
      })
      .returning();
    resumeId = resume!.resumeId;

    token = await signTestToken({ sub: userId, sid: randomUUID(), org: null, role: null, email });
    otherToken = await signTestToken({ sub: otherUserId, sid: randomUUID(), org: null, role: null, email: otherEmail });
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.applications).where(eq(schema.applications.userId, userId));
    await dbHandle.db.delete(schema.jobs).where(eq(schema.jobs.companyId, companyId));
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.companyId, companyId));
    await dbHandle.db.delete(schema.resumes).where(eq(schema.resumes.userId, userId));
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, userId));
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, otherUserId));
    await app.close();
    await dbHandle.close();
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: { authorization: `Bearer ${token}` },
      payload: { job_id: jobId, resume_id: resumeId, mode: 'manual' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  let applicationId: string;

  it('creates a draft application for a manual submission', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-key-1-manual' },
      payload: { job_id: jobId, resume_id: resumeId, mode: 'manual' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.application.status).toBe('draft');
    applicationId = body.application.application_id;
  });

  it('replays the same idempotency key + same body as a no-op', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-key-1-manual' },
      payload: { job_id: jobId, resume_id: resumeId, mode: 'manual' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().application.application_id).toBe(applicationId);
  });

  it('rejects a fresh idempotency key for a job the user already applied to', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-key-2-different' },
      payload: { job_id: jobId, resume_id: resumeId, mode: 'manual' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('starts an auto-mode application already queued', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-key-3-auto' },
      payload: { job_id: secondJobId, resume_id: resumeId, mode: 'auto' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().application.status).toBe('queued');
  });

  it('lists the caller\'s own applications', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/applications', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((a: { application_id: string }) => a.application_id)).toContain(applicationId);
  });

  it("404s when another user fetches someone else's application", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/applications/${applicationId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an invalid lifecycle transition', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/applications/${applicationId}/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: { to_status: 'offer' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('walks the application through a valid lifecycle to submitted', async () => {
    for (const to_status of ['queued', 'submitting', 'submitted']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/applications/${applicationId}/events`,
        headers: { authorization: `Bearer ${token}` },
        payload: { to_status },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().application.status).toBe(to_status);
    }

    const finalRes = await app.inject({
      method: 'GET',
      url: `/v1/applications/${applicationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(finalRes.json().application.submitted_at).not.toBeNull();
  });

  describe('org-wide listing (apps/admin)', () => {
    const organizationId = randomUUID();
    let adminToken: string;
    let orgScopeJobId: string;

    beforeAll(async () => {
      await dbHandle.db.insert(schema.organizations).values({ organizationId, name: `Org ${organizationId.slice(0, 8)}`, type: 'enterprise' });
      adminToken = await signTestToken({ sub: userId, sid: randomUUID(), org: organizationId, role: 'admin', email });

      // A fresh job: applications_user_job_key means (userId, job_id) can
      // only apply once, and userId already applied to jobId/secondJobId above.
      const [job] = await dbHandle.db
        .insert(schema.jobs)
        .values({ companyId, title: 'Org Scope Job', source: 'manual', jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), isActive: true })
        .returning();
      orgScopeJobId = job!.jobId;

      await app.inject({
        method: 'POST',
        url: '/v1/applications',
        headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': 'idem-key-org-scope' },
        payload: { job_id: orgScopeJobId, resume_id: resumeId, mode: 'manual' },
      });
    });

    afterAll(async () => {
      await dbHandle.db.delete(schema.organizations).where(eq(schema.organizations.organizationId, organizationId));
    });

    it('rejects scope=organization from a non-admin caller', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/applications?scope=organization',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('lets an org admin list the whole organization\'s applications', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/applications?scope=organization',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items.every((a: { organization_id: string }) => a.organization_id === organizationId)).toBe(true);
    });
  });
});
