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
import { loadApplicationsServiceEnv } from '../src/env.js';

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
    await stubJwks();
    const env = loadApplicationsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4005', SUPABASE_URL });
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

    // public.users.user_id FKs to auth.users.id (see packages/db/supabase/auth-hooks.sql);
    // inserting into auth.users fires handle_new_user, which creates the matching
    // public.users row itself.
    for (const u of [
      { id: userId, email, fullName: 'Applications Flow Test User' },
      { id: otherUserId, email: otherEmail, fullName: 'Someone Else' },
    ]) {
      await dbHandle.sql`
        insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values (${u.id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${u.email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: u.fullName })}::jsonb, now(), now())
      `;
    }
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
    // Cascades to public.users via the auth.users FK.
    await dbHandle.sql`delete from auth.users where id in (${userId}, ${otherUserId})`;
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
