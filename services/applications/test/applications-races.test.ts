import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createBroker } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { isValidTransition } from '../src/lib/transitions.js';
import { buildApp } from '../src/app.js';
import { loadApplicationsServiceEnv } from '../src/env.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const SUPABASE_URL = 'https://test-project.supabase.co';

/**
 * Requests that arrive together: a double click, a retry racing the original, a user and a staff
 * member acting on the same application. The service reads, decides, then writes, so what these
 * check is that the decision was still true when the write happened.
 */
describe.skipIf(!testDatabaseUrl)('applications-service under concurrent requests', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let token: string;
  const userId = randomUUID();
  const email = `applications-races-${userId}@example.com`;
  const companyName = `Races Test Co ${randomUUID().slice(0, 8)}`;
  let companyId: string;
  let resumeId: string;
  const jobIds: string[] = [];
  const published: string[] = [];

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
    token = await new SignJWT({ session_id: randomUUID(), email, app_metadata: {} })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(userId)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(privateKey);

    const env = loadApplicationsServiceEnv({
      DATABASE_URL: testDatabaseUrl,
      PORT: '4005',
      SUPABASE_URL,
      // The limiter is not what is under test here.
      RATE_LIMIT_MAX: '100000',
    });
    dbHandle = createDatabase({ url: env.DATABASE_URL, maxConnections: 20 });
    const broker = createBroker({ driver: 'memory', logger: createSilentLogger() });
    const publish = broker.publish.bind(broker);
    broker.publish = async (envelope) => {
      published.push(envelope.event_type);
      return publish(envelope);
    };
    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      broker,
      tokenVerifier: createTokenVerifierConfig(env),
    });
    await app.ready();

    await dbHandle.sql`
      insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: 'Races Test User' })}::jsonb, now(), now())
    `;
    const [company] = await dbHandle.db
      .insert(schema.companies)
      .values({ name: companyName, normalizedName: companyName.toLowerCase() })
      .returning();
    companyId = company!.companyId;
    for (let index = 0; index < 8; index += 1) {
      const [job] = await dbHandle.db
        .insert(schema.jobs)
        .values({ companyId, title: `Races Job ${index}`, source: 'manual', jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), isActive: true })
        .returning();
      jobIds.push(job!.jobId);
    }
    const [resume] = await dbHandle.db
      .insert(schema.resumes)
      .values({ userId, storageUrl: `resumes/${userId}/seed`, originalFilename: 'resume.txt', contentType: 'text/plain', byteSize: 10, contentHash: randomUUID(), status: 'parsed' })
      .returning();
    resumeId = resume!.resumeId;
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.applications).where(eq(schema.applications.userId, userId));
    await dbHandle.db.delete(schema.jobs).where(eq(schema.jobs.companyId, companyId));
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.companyId, companyId));
    await dbHandle.db.delete(schema.resumes).where(eq(schema.resumes.userId, userId));
    await dbHandle.sql`delete from auth.users where id = ${userId}`;
    await app.close();
    await dbHandle.close();
  });

  // The per-address limiter (30 creates a minute) is not what is under test, so each request
  // comes from its own address.
  let nextAddress = 0;
  const address = () => `10.${(nextAddress >> 16) & 255}.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

  const create = (jobId: string, key: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'x-forwarded-for': address() },
      payload: { job_id: jobId, resume_id: resumeId, mode: 'manual' },
    });
  const move = (applicationId: string, to_status: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/applications/${applicationId}/events`,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': address() },
      payload: { to_status },
    });
  const rowsFor = (jobId: string) =>
    dbHandle.db.select().from(schema.applications).where(eq(schema.applications.jobId, jobId));
  const trail = (applicationId: string) =>
    dbHandle.db
      .select()
      .from(schema.applicationEvents)
      .where(eq(schema.applicationEvents.applicationId, applicationId))
      .orderBy(asc(schema.applicationEvents.createdAt), asc(schema.applicationEvents.eventId));
  const spread = (statuses: number[]) => [...new Set(statuses)].sort();

  async function applicationIn(jobIndex: number, path: string[]): Promise<string> {
    const jobId = jobIds[jobIndex]!;
    const res = await create(jobId, `seed-${jobId}`);
    expect(res.statusCode).toBe(201);
    const applicationId = res.json().application.application_id as string;
    for (const status of path) expect((await move(applicationId, status)).statusCode).toBe(200);
    return applicationId;
  }

  /** The trail is a chain: each event starts where the one before ended, by a legal move, and the head is its last stop. */
  async function expectConsistentTrail(applicationId: string): Promise<void> {
    const events = await trail(applicationId);
    const [application] = await dbHandle.db
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.applicationId, applicationId));
    let at = 'draft';
    for (const event of events) {
      expect(event.fromStatus, `event ${event.fromStatus} -> ${event.toStatus} does not start where the previous one ended (${at})`).toBe(at);
      expect(isValidTransition(event.fromStatus!, event.toStatus)).toBe(true);
      at = event.toStatus;
    }
    expect(application!.status).toBe(at);
  }

  it('30 identical creates (same key, same body) make one application and no errors', async () => {
    const jobId = jobIds[0]!;
    const results = await Promise.all(Array.from({ length: 30 }, () => create(jobId, 'same-key-everywhere')));

    expect(spread(results.map((res) => res.statusCode))).toEqual(expect.arrayContaining([201]));
    expect(results.map((res) => res.statusCode).every((code) => code === 200 || code === 201)).toBe(true);
    expect(new Set(results.map((res) => res.json().application.application_id)).size).toBe(1);
    expect(await rowsFor(jobId)).toHaveLength(1);
  });

  it('30 creates for one job with different keys make one application; the rest are conflicts, never 500s', async () => {
    const jobId = jobIds[1]!;
    const results = await Promise.all(Array.from({ length: 30 }, (_unused, index) => create(jobId, `distinct-key-${index}`)));

    const codes = results.map((res) => res.statusCode);
    expect(codes.filter((code) => code === 201)).toHaveLength(1);
    expect(codes.filter((code) => code === 409)).toHaveLength(29);
    expect(await rowsFor(jobId)).toHaveLength(1);
  });

  it('20 simultaneous "queued" requests move the application once and leave one event', async () => {
    const applicationId = await applicationIn(2, []);
    const results = await Promise.all(Array.from({ length: 20 }, () => move(applicationId, 'queued')));

    const codes = results.map((res) => res.statusCode);
    expect(codes.filter((code) => code === 200)).toHaveLength(1);
    expect(codes.every((code) => code === 200 || code === 400 || code === 409)).toBe(true);
    const events = await trail(applicationId);
    expect(events.filter((event) => event.toStatus === 'queued')).toHaveLength(1);
    await expectConsistentTrail(applicationId);
  });

  it('simultaneous "submitted" requests publish application.submitted once', async () => {
    const applicationId = await applicationIn(3, ['queued', 'submitting']);
    const before = published.filter((type) => type === 'application.submitted').length;
    const results = await Promise.all(Array.from({ length: 15 }, () => move(applicationId, 'submitted')));

    expect(results.filter((res) => res.statusCode === 200)).toHaveLength(1);
    expect(published.filter((type) => type === 'application.submitted').length - before).toBe(1);
    await expectConsistentTrail(applicationId);
  });

  it('a terminal status stays terminal when "offer" and "rejected" arrive together', async () => {
    const applicationIds: string[] = [];
    for (const jobIndex of [4, 5, 6, 7]) {
      applicationIds.push(await applicationIn(jobIndex, ['submitted', 'interviewing']));
    }
    for (const applicationId of applicationIds) {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_unused, index) => move(applicationId, index % 2 === 0 ? 'offer' : 'rejected')),
      );
      expect(results.every((res) => [200, 400, 409].includes(res.statusCode))).toBe(true);
      await expectConsistentTrail(applicationId);
    }
    const heads = await dbHandle.db
      .select({ status: schema.applications.status })
      .from(schema.applications)
      .where(inArray(schema.applications.applicationId, applicationIds));
    // "rejected" has no way out: if any application ended on "offer", it got there after being rejected,
    // or both moves were recorded from "interviewing" - the trail check above catches both.
    expect(heads.every((head) => head.status === 'offer' || head.status === 'rejected')).toBe(true);
  });
});
