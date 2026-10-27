import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createBroker } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { applicationJobSummarySchema, applicationSchema, type ApplicationJobSummary } from '@atlas/types';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadApplicationsServiceEnv } from '../src/env.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const SUPABASE_URL = 'https://test-project.supabase.co';

/** Exactly the fields `applicationSchema` defines — what org staff are allowed to see, and nothing more. */
const APPLICATION_KEYS = Object.keys(applicationSchema.shape).sort();

interface Claims {
  sub: string;
  sid: string;
  org: string | null;
  role: string | null;
  email: string;
}

let signTestToken: (claims: Claims) => Promise<string>;

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

describe.skipIf(!testDatabaseUrl)('applications-service job context', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  // Every query the HTTP layer issues lands here, so tests can prove "one join, no N+1".
  const queries: string[] = [];
  let canBypassForeignKeys = false;

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const organizationIds: string[] = [];

  async function seedUser(label: string): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = `job-context-${label}-${id}@example.com`;
    // public.users.user_id FKs to auth.users.id; inserting into auth.users fires
    // handle_new_user, which creates the matching public.users row itself.
    await dbHandle.sql`
      insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: `Job Context ${label}` })}::jsonb, now(), now())
    `;
    userIds.push(id);
    return { id, email };
  }

  async function seedResume(userId: string): Promise<string> {
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
    return resume!.resumeId;
  }

  async function seedCompany(name = `Job Context Co ${randomUUID().slice(0, 8)}`): Promise<{ companyId: string; name: string }> {
    const [company] = await dbHandle.db
      .insert(schema.companies)
      .values({ name, normalizedName: `${name.toLowerCase()} ${randomUUID()}` })
      .returning();
    companyIds.push(company!.companyId);
    return { companyId: company!.companyId, name };
  }

  async function seedJob(
    companyId: string,
    overrides: Partial<typeof schema.jobs.$inferInsert> = {},
  ): Promise<typeof schema.jobs.$inferSelect> {
    const [job] = await dbHandle.db
      .insert(schema.jobs)
      .values({
        companyId,
        title: 'Backend Engineer',
        source: 'manual',
        jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        isActive: true,
        ...overrides,
      })
      .returning();
    return job!;
  }

  async function seedApplication(
    userId: string,
    jobId: string,
    resumeId: string,
    overrides: Partial<typeof schema.applications.$inferInsert> = {},
  ): Promise<typeof schema.applications.$inferSelect> {
    const [row] = await dbHandle.db
      .insert(schema.applications)
      .values({ userId, jobId, resumeId, mode: 'manual', status: 'draft', idempotencyKey: `idem-${randomUUID()}`, ...overrides })
      .returning();
    return row!;
  }

  function auth(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  /** Deletes a parent row WITHOUT firing the FK cascade, leaving the child dangling (superuser-only). */
  async function deleteWithoutCascade(table: 'companies' | 'jobs', column: 'company_id' | 'job_id', id: string): Promise<void> {
    await dbHandle.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from ${tx(table)} where ${tx(column)} = ${id}`;
    });
  }

  beforeAll(async () => {
    await stubJwks();
    const env = loadApplicationsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4005', SUPABASE_URL });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    const countingDb = drizzle(dbHandle.sql, {
      schema,
      logger: {
        logQuery: (query) => {
          queries.push(query);
        },
      },
    });
    app = buildApp({
      db: countingDb,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      broker: createBroker({ driver: 'memory', logger: createSilentLogger() }),
      tokenVerifier: createTokenVerifierConfig(env),
    });
    await app.ready();

    const [role] = await dbHandle.sql`select rolsuper from pg_roles where rolname = current_user`;
    canBypassForeignKeys = role?.rolsuper === true;
  });

  afterAll(async () => {
    if (userIds.length > 0) await dbHandle.db.delete(schema.applications).where(inArray(schema.applications.userId, userIds));
    if (companyIds.length > 0) {
      await dbHandle.db.delete(schema.jobs).where(inArray(schema.jobs.companyId, companyIds));
      await dbHandle.db.delete(schema.companies).where(inArray(schema.companies.companyId, companyIds));
    }
    if (userIds.length > 0) await dbHandle.db.delete(schema.resumes).where(inArray(schema.resumes.userId, userIds));
    if (organizationIds.length > 0) {
      await dbHandle.db.delete(schema.organizations).where(inArray(schema.organizations.organizationId, organizationIds));
    }
    // Cascades to public.users via the auth.users FK.
    if (userIds.length > 0) await dbHandle.sql`delete from auth.users where id in ${dbHandle.sql(userIds)}`;
    await app.close();
    await dbHandle.close();
  });

  describe('create / get / list carry the job for the owner', () => {
    let ownerToken: string;
    let strangerToken: string;
    let ownerId: string;
    let resumeId: string;
    let company: { companyId: string; name: string };
    let job: typeof schema.jobs.$inferSelect;
    let expectedJob: ApplicationJobSummary;
    let applicationId: string;

    beforeAll(async () => {
      const owner = await seedUser('owner');
      const stranger = await seedUser('stranger');
      ownerId = owner.id;
      resumeId = await seedResume(owner.id);
      company = await seedCompany();
      job = await seedJob(company.companyId, {
        title: 'Staff Platform Engineer',
        location: 'Lisbon, Portugal',
        remoteType: 'hybrid',
        employmentType: 'full_time',
        applyUrl: 'https://careers.jobctx.example/apply/123',
      });
      expectedJob = {
        job_id: job.jobId,
        title: 'Staff Platform Engineer',
        company_id: company.companyId,
        company_name: company.name,
        location: 'Lisbon, Portugal',
        remote_type: 'hybrid',
        employment_type: 'full_time',
        apply_url: 'https://careers.jobctx.example/apply/123',
        is_active: true,
      };
      ownerToken = await signTestToken({ sub: owner.id, sid: randomUUID(), org: null, role: null, email: owner.email });
      strangerToken = await signTestToken({ sub: stranger.id, sid: randomUUID(), org: null, role: null, email: stranger.email });
    });

    it('returns the job summary on create (default mode)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/applications',
        headers: { ...auth(ownerToken), 'idempotency-key': 'job-ctx-create-1' },
        payload: { job_id: job.jobId, resume_id: resumeId },
      });
      expect(res.statusCode).toBe(201);
      const { application } = res.json();
      expect(application).toMatchObject({ job_id: job.jobId, user_id: ownerId, status: 'draft', mode: 'manual' });
      expect(application.job).toEqual(expectedJob);
      expect(applicationJobSummarySchema.safeParse(application.job).success).toBe(true);
      applicationId = application.application_id;
    });

    it('returns the same job summary when the create is replayed with the same idempotency key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/applications',
        headers: { ...auth(ownerToken), 'idempotency-key': 'job-ctx-create-1' },
        payload: { job_id: job.jobId, resume_id: resumeId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().application.application_id).toBe(applicationId);
      expect(res.json().application.job).toEqual(expectedJob);
    });

    it('accepts mode "review" as an editable draft, with its job', async () => {
      const reviewJob = await seedJob(company.companyId, { title: 'Review Mode Role' });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/applications',
        headers: { ...auth(ownerToken), 'idempotency-key': 'job-ctx-create-review' },
        payload: { job_id: reviewJob.jobId, resume_id: resumeId, mode: 'review' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().application).toMatchObject({ mode: 'review', status: 'draft' });
      expect(res.json().application.job).toMatchObject({ job_id: reviewJob.jobId, title: 'Review Mode Role' });
    });

    it('returns the job summary on GET /v1/applications/:id with a single query', async () => {
      queries.length = 0;
      const res = await app.inject({ method: 'GET', url: `/v1/applications/${applicationId}`, headers: auth(ownerToken) });
      expect(res.statusCode).toBe(200);
      expect(res.json().application.job).toEqual(expectedJob);
      expect(res.json().application.job.title).toBe('Staff Platform Engineer');
      expect(res.json().application.job.company_name).toBe(company.name);
      expect(queries).toHaveLength(1);
    });

    it('returns the job on every item of GET /v1/applications with a single query', async () => {
      queries.length = 0;
      const res = await app.inject({ method: 'GET', url: '/v1/applications', headers: auth(ownerToken) });
      expect(res.statusCode).toBe(200);

      const items = res.json().items as Array<{ application_id: string; job: ApplicationJobSummary | null }>;
      expect(items.length).toBeGreaterThanOrEqual(2);
      for (const item of items) {
        expect(item.job).not.toBeNull();
        expect(applicationJobSummarySchema.safeParse(item.job).success).toBe(true);
      }
      expect(items.find((i) => i.application_id === applicationId)?.job).toEqual(expectedJob);

      // One join, not one lookup per row — and nothing heavy dragged along from `jobs`.
      expect(queries).toHaveLength(1);
      expect(queries[0]).not.toMatch(/"description"|"embedding"/);
    });

    it("still 404s when another user fetches, lists or updates someone else's application", async () => {
      const get = await app.inject({ method: 'GET', url: `/v1/applications/${applicationId}`, headers: auth(strangerToken) });
      expect(get.statusCode).toBe(404);
      expect(JSON.stringify(get.json())).not.toContain(company.name);

      const event = await app.inject({
        method: 'POST',
        url: `/v1/applications/${applicationId}/events`,
        headers: auth(strangerToken),
        payload: { to_status: 'submitted' },
      });
      expect(event.statusCode).toBe(404);

      const list = await app.inject({ method: 'GET', url: '/v1/applications', headers: auth(strangerToken) });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toEqual([]);
    });

    it('404s on an unknown application id', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/applications/${randomUUID()}`, headers: auth(ownerToken) });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('job summary details', () => {
    let token: string;
    let userId: string;
    const titles = {
      unsafe: 'Unsafe Link Role',
      data: 'Data Link Role',
      garbage: 'Garbage Link Role',
      none: 'No Link Role',
      inactive: 'Inactive Role',
      bare: 'Bare Minimum Role',
    };

    beforeAll(async () => {
      const user = await seedUser('details');
      userId = user.id;
      token = await signTestToken({ sub: user.id, sid: randomUUID(), org: null, role: null, email: user.email });
      const resumeId = await seedResume(user.id);
      const company = await seedCompany();
      const rows: Array<Partial<typeof schema.jobs.$inferInsert>> = [
        { title: titles.unsafe, applyUrl: 'javascript:alert(document.cookie)' },
        { title: titles.data, applyUrl: 'data:text/html,<script>alert(1)</script>' },
        { title: titles.garbage, applyUrl: 'not a url at all' },
        { title: titles.none, applyUrl: null },
        // An application outlives its job being deactivated; the owner still sees it, flagged.
        { title: titles.inactive, isActive: false, applyUrl: 'https://careers.jobctx.example/closed' },
        { title: titles.bare, location: null, applyUrl: null },
      ];
      for (const overrides of rows) {
        const job = await seedJob(company.companyId, overrides);
        await seedApplication(user.id, job.jobId, resumeId);
      }
    });

    async function jobsByTitle(): Promise<Record<string, ApplicationJobSummary | null>> {
      const res = await app.inject({ method: 'GET', url: '/v1/applications?limit=50', headers: auth(token) });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<{ user_id: string; job: ApplicationJobSummary | null }>;
      expect(items.every((i) => i.user_id === userId)).toBe(true);
      return Object.fromEntries(items.map((i) => [i.job?.title ?? 'null', i.job]));
    }

    it('only ever serves http(s) apply links; anything else becomes null', async () => {
      const byTitle = await jobsByTitle();
      expect(byTitle[titles.unsafe]?.apply_url).toBeNull();
      expect(byTitle[titles.data]?.apply_url).toBeNull();
      expect(byTitle[titles.garbage]?.apply_url).toBeNull();
      expect(byTitle[titles.none]?.apply_url).toBeNull();
      expect(byTitle[titles.inactive]?.apply_url).toBe('https://careers.jobctx.example/closed');
    });

    it('keeps an application whose job was deactivated, flagged is_active=false', async () => {
      const byTitle = await jobsByTitle();
      expect(byTitle[titles.inactive]?.is_active).toBe(false);
    });

    it('serves a job without a location as location=null and a valid summary', async () => {
      const byTitle = await jobsByTitle();
      expect(byTitle[titles.bare]).toMatchObject({ location: null, remote_type: 'unknown', employment_type: 'unknown', is_active: true });
    });
  });

  describe('null-safety when the job or its company is gone', () => {
    let token: string;
    let userId: string;
    let resumeId: string;

    beforeAll(async () => {
      const user = await seedUser('dangling');
      userId = user.id;
      token = await signTestToken({ sub: user.id, sid: randomUUID(), org: null, role: null, email: user.email });
      resumeId = await seedResume(user.id);
    });

    it('returns job: null (and every other field intact) when the company row is gone', async (ctx) => {
      if (!canBypassForeignKeys) ctx.skip();

      // Foreign keys cascade, so a dangling row can only be produced by deleting the parent without firing them.
      // A dedicated, inactive job keeps the window in which it exists tiny and invisible to other suites.
      const company = await seedCompany();
      const job = await seedJob(company.companyId, { title: 'Orphaned By Company', isActive: false });
      const application = await seedApplication(userId, job.jobId, resumeId);

      try {
        const before = await app.inject({ method: 'GET', url: `/v1/applications/${application.applicationId}`, headers: auth(token) });
        expect(before.json().application.job).toMatchObject({ title: 'Orphaned By Company', company_name: company.name });

        await deleteWithoutCascade('companies', 'company_id', company.companyId);

        const get = await app.inject({ method: 'GET', url: `/v1/applications/${application.applicationId}`, headers: auth(token) });
        expect(get.statusCode).toBe(200);
        expect(get.json().application).toMatchObject({ application_id: application.applicationId, job_id: job.jobId, status: 'draft' });
        expect(get.json().application).toHaveProperty('job', null);

        const list = await app.inject({ method: 'GET', url: '/v1/applications', headers: auth(token) });
        expect(list.statusCode).toBe(200);
        const item = (list.json().items as Array<{ application_id: string }>).find((i) => i.application_id === application.applicationId);
        expect(item).toHaveProperty('job', null);
      } finally {
        await dbHandle.db.delete(schema.applications).where(eq(schema.applications.applicationId, application.applicationId));
        await dbHandle.db.delete(schema.jobs).where(eq(schema.jobs.jobId, job.jobId));
      }
    });

    it('returns job: null when the job row itself is gone', async (ctx) => {
      if (!canBypassForeignKeys) ctx.skip();

      const company = await seedCompany();
      const job = await seedJob(company.companyId, { title: 'Orphaned By Job', isActive: false });
      const application = await seedApplication(userId, job.jobId, resumeId);

      try {
        await deleteWithoutCascade('jobs', 'job_id', job.jobId);

        const get = await app.inject({ method: 'GET', url: `/v1/applications/${application.applicationId}`, headers: auth(token) });
        expect(get.statusCode).toBe(200);
        expect(get.json().application).toMatchObject({ application_id: application.applicationId, job_id: job.jobId });
        expect(get.json().application).toHaveProperty('job', null);

        const list = await app.inject({ method: 'GET', url: '/v1/applications', headers: auth(token) });
        const item = (list.json().items as Array<{ application_id: string }>).find((i) => i.application_id === application.applicationId);
        expect(item).toHaveProperty('job', null);
      } finally {
        await dbHandle.db.delete(schema.applications).where(eq(schema.applications.applicationId, application.applicationId));
      }
    });
  });

  describe('pagination keeps order and job context across pages', () => {
    let token: string;
    const expected: Array<{ applicationId: string; createdAt: string; title: string }> = [];

    beforeAll(async () => {
      const user = await seedUser('pager');
      token = await signTestToken({ sub: user.id, sid: randomUUID(), org: null, role: null, email: user.email });
      const resumeId = await seedResume(user.id);
      const company = await seedCompany();

      // Two applications share a timestamp so the (created_at, id) tie-break is
      // exercised exactly where a page boundary falls (positions 2 and 3).
      const base = Date.now() - 60_000;
      const stamps = [4, 3, 3, 1, 0].map((s) => new Date(base + s * 1000).toISOString());
      for (const [i, createdAt] of stamps.entries()) {
        const title = `Paged Role ${i}`;
        const job = await seedJob(company.companyId, { title, applyUrl: `https://careers.jobctx.example/paged/${i}` });
        const row = await seedApplication(user.id, job.jobId, resumeId, { createdAt });
        expected.push({ applicationId: row.applicationId, createdAt, title });
      }
      expected.sort((a, b) => {
        const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        if (byTime !== 0) return byTime;
        return a.applicationId < b.applicationId ? 1 : -1; // id DESC, matching the query's ORDER BY
      });
    });

    it('walks 5 applications in 3 pages, in a stable order, with a job on every item', async () => {
      const seen: string[] = [];
      const pageSizes: number[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 5; page += 1) {
        queries.length = 0;
        const url: string = cursor ? `/v1/applications?limit=2&cursor=${encodeURIComponent(cursor)}` : '/v1/applications?limit=2';
        const res = await app.inject({ method: 'GET', url, headers: auth(token) });
        expect(res.statusCode).toBe(200);
        expect(queries).toHaveLength(1);

        const body = res.json() as { items: Array<{ application_id: string; job: ApplicationJobSummary | null }>; next_cursor: string | null };
        pageSizes.push(body.items.length);
        for (const item of body.items) {
          const want = expected.find((e) => e.applicationId === item.application_id);
          expect(want).toBeDefined();
          expect(item.job).not.toBeNull();
          expect(item.job?.title).toBe(want?.title);
          expect(item.job?.apply_url).toMatch(/^https:\/\/careers\.jobctx\.example\/paged\/\d$/);
          seen.push(item.application_id);
        }

        cursor = body.next_cursor;
        if (cursor === null) break;
      }

      expect(pageSizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(expected.map((e) => e.applicationId));
      expect(new Set(seen).size).toBe(5);
    });

    it('returns the same single page, in the same order, when everything fits in one request', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/applications?limit=50', headers: auth(token) });
      expect(res.json().items.map((i: { application_id: string }) => i.application_id)).toEqual(expected.map((e) => e.applicationId));
      expect(res.json().next_cursor).toBeNull();
    });
  });

  describe('organization staff never get job or employer details', () => {
    let organizationId: string;
    let studentId: string;
    let studentToken: string;
    let studentAsAdminToken: string;
    let staffToken: string;
    let resumeId: string;
    let companyName: string;
    const jobTitle = `Confidential Role ${randomUUID().slice(0, 8)}`;
    const applyUrl = 'https://careers.confidential.example/apply/secret-role';
    let studentApplicationId: string;
    let secondApplicationId: string;

    beforeAll(async () => {
      organizationId = randomUUID();
      await dbHandle.db.insert(schema.organizations).values({ organizationId, name: `Staff Org ${organizationId.slice(0, 8)}`, type: 'university' });
      organizationIds.push(organizationId);

      const student = await seedUser('student');
      const staff = await seedUser('staff');
      studentId = student.id;
      resumeId = await seedResume(student.id);
      studentToken = await signTestToken({ sub: student.id, sid: randomUUID(), org: organizationId, role: 'student', email: student.email });
      studentAsAdminToken = await signTestToken({ sub: student.id, sid: randomUUID(), org: organizationId, role: 'admin', email: student.email });
      staffToken = await signTestToken({ sub: staff.id, sid: randomUUID(), org: organizationId, role: 'admin', email: staff.email });

      const company = await seedCompany(`Confidential Employer ${randomUUID().slice(0, 8)}`);
      companyName = company.name;
      const first = await seedJob(company.companyId, { title: jobTitle, applyUrl, location: 'Secret City' });
      const second = await seedJob(company.companyId, { title: `${jobTitle} II`, applyUrl });

      for (const [key, jobId] of [
        ['staff-privacy-1', first.jobId],
        ['staff-privacy-2', second.jobId],
      ] as const) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/applications',
          headers: { ...auth(studentToken), 'idempotency-key': key },
          payload: { job_id: jobId, resume_id: resumeId },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().application.organization_id).toBe(organizationId);
        if (key === 'staff-privacy-1') studentApplicationId = res.json().application.application_id;
        else secondApplicationId = res.json().application.application_id;
      }
    });

    /** Fails the test if anything about the job or employer is visible anywhere in the payload. */
    function expectNoJobDetails(payload: unknown): void {
      const text = JSON.stringify(payload);
      for (const secret of [jobTitle, companyName, applyUrl, 'Secret City', '"job"', 'company_name', 'company_id', 'apply_url', 'remote_type', 'employment_type']) {
        expect(text).not.toContain(secret);
      }
    }

    it('lists the organization with application fields only, via a query that never touches jobs or companies', async () => {
      queries.length = 0;
      const res = await app.inject({ method: 'GET', url: '/v1/applications?scope=organization', headers: auth(staffToken) });
      expect(res.statusCode).toBe(200);

      const items = res.json().items as Array<Record<string, unknown>>;
      expect(items.map((i) => i.application_id)).toEqual(expect.arrayContaining([studentApplicationId, secondApplicationId]));
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(APPLICATION_KEYS);
        expect(item).not.toHaveProperty('job');
      }
      expectNoJobDetails(res.json());

      expect(queries).toHaveLength(1);
      expect(queries[0]).not.toMatch(/"jobs"|"companies"/);
    });

    it('keeps job details out of every page of the paginated organization list', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const url: string = cursor
          ? `/v1/applications?scope=organization&limit=1&cursor=${encodeURIComponent(cursor)}`
          : '/v1/applications?scope=organization&limit=1';
        const res = await app.inject({ method: 'GET', url, headers: auth(staffToken) });
        expect(res.statusCode).toBe(200);
        expectNoJobDetails(res.json());
        for (const item of res.json().items as Array<{ application_id: string }>) seen.push(item.application_id);
        cursor = res.json().next_cursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual(expect.arrayContaining([studentApplicationId, secondApplicationId]));
    });

    it('returns the plain application to staff on GET /v1/applications/:id', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/applications/${studentApplicationId}`, headers: auth(staffToken) });
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json().application).sort()).toEqual(APPLICATION_KEYS);
      expectNoJobDetails(res.json());
    });

    it('returns the plain application to staff from POST /v1/applications/:id/events', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/applications/${secondApplicationId}/events`,
        headers: auth(staffToken),
        payload: { to_status: 'withdrawn', note: 'withdrawn by staff' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().application.status).toBe('withdrawn');
      expect(Object.keys(res.json().application).sort()).toEqual(APPLICATION_KEYS);
      expectNoJobDetails(res.json());
    });

    it("hides job details even from a staff member's own applications in the organization view, but not in their owner view", async () => {
      // Same person, admin role: the org-wide list is the staff surface, so it stays job-free...
      const orgList = await app.inject({ method: 'GET', url: '/v1/applications?scope=organization', headers: auth(studentAsAdminToken) });
      expect(orgList.statusCode).toBe(200);
      const own = (orgList.json().items as Array<{ application_id: string; user_id: string }>).filter((i) => i.user_id === studentId);
      expect(own.length).toBeGreaterThanOrEqual(2);
      expectNoJobDetails(orgList.json());

      // ...while the same person asking for their own applications gets the owner's view.
      const mine = await app.inject({ method: 'GET', url: '/v1/applications', headers: auth(studentAsAdminToken) });
      const mineItem = (mine.json().items as Array<{ application_id: string; job: ApplicationJobSummary | null }>).find(
        (i) => i.application_id === studentApplicationId,
      );
      expect(mineItem?.job).toMatchObject({ title: jobTitle, company_name: companyName, apply_url: applyUrl });

      const get = await app.inject({ method: 'GET', url: `/v1/applications/${studentApplicationId}`, headers: auth(studentAsAdminToken) });
      expect(get.json().application.job).toMatchObject({ title: jobTitle, company_name: companyName });
    });

    it('still rejects scope=organization for a non-staff member of the organization', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/applications?scope=organization', headers: auth(studentToken) });
      expect(res.statusCode).toBe(403);
      expectNoJobDetails(res.json());
    });
  });
});
