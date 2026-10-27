/**
 * Cross-service events over the `postgres` messaging driver.
 *
 * Every service below is a separate "function": its own app, its own database
 * pool and its own broker instance, sharing nothing in memory with the others
 * — which is the situation on Vercel and exactly what the in-memory driver
 * cannot model. The services are driven only through their HTTP surface
 * (profile upload, job ingest, application creation, `/internal/drain`, the
 * recommendations endpoint); the only thing connecting them is the outbox in
 * the shared database.
 *
 * It reaches into services/* because this is the one place that can see both
 * sides of an event; production code never imports across services.
 *
 * The test uses the real tables and the real consumer names, so it must not
 * run while another process drains the same database's outbox. DB-backed
 * tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, type DatabaseHandle } from '@atlas/db';
import { createStorage } from '@atlas/storage';
import { createSilentLogger } from '@atlas/utils';
import { buildApp as buildAnalyticsApp } from '../../../services/analytics/src/app.js';
import { loadAnalyticsServiceEnv } from '../../../services/analytics/src/env.js';
import { registerConsumers as registerAnalyticsConsumers } from '../../../services/analytics/src/worker.js';
import { buildApp as buildApplicationsApp } from '../../../services/applications/src/app.js';
import { loadApplicationsServiceEnv } from '../../../services/applications/src/env.js';
import { buildApp as buildJobsApp } from '../../../services/jobs/src/app.js';
import { loadJobsServiceEnv } from '../../../services/jobs/src/env.js';
import { buildApp as buildLearningApp } from '../../../services/learning/src/app.js';
import { loadLearningServiceEnv } from '../../../services/learning/src/env.js';
import { registerConsumers as registerLearningConsumers } from '../../../services/learning/src/worker.js';
import { buildApp as buildMatchingApp } from '../../../services/matching/src/app.js';
import { loadMatchingServiceEnv } from '../../../services/matching/src/env.js';
import { registerConsumers as registerMatchingConsumers } from '../../../services/matching/src/worker.js';
import { buildApp as buildProfileApp } from '../../../services/profile/src/app.js';
import { loadProfileServiceEnv } from '../../../services/profile/src/env.js';
import { buildApp as buildReferralsApp } from '../../../services/referrals/src/app.js';
import { loadReferralsServiceEnv } from '../../../services/referrals/src/env.js';
import { registerConsumers as registerReferralsConsumers } from '../../../services/referrals/src/worker.js';
import { createBroker, type EventBroker, type Subscription } from '../src/index.js';

const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const SUPABASE_URL = 'https://test-project.supabase.co';
const CRON_SECRET = 'cross-service-cron-secret-0123456789';

/** The consumers this test drives; their registry rows are reset around it. */
const CONSUMERS = [
  'matching-service.resume-parsed',
  'matching-service.job-discovered',
  'referrals-service.application-created',
  'learning-service.application-created',
  'analytics-service.event-recorder',
];

type SignClaims = { sub: string; role: string | null; email: string };
let signTestToken: (claims: SignClaims) => Promise<string>;

// createRemoteJWKSet fetches over HTTP — serve a locally generated key instead.
async function stubJwks(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  signTestToken = async (claims) =>
    new SignJWT({
      session_id: randomUUID(),
      email: claims.email,
      app_metadata: { org_id: null, role: claims.role },
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(claims.sub)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(privateKey);
}

function multipartResume(boundary: string, filename: string, text: string): Buffer {
  const CRLF = '\r\n';
  return Buffer.concat([
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
        `Content-Type: text/plain${CRLF}${CRLF}`,
      'utf8',
    ),
    Buffer.from(text, 'utf8'),
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'),
  ]);
}

const logger = createSilentLogger();

describe.skipIf(!testDatabaseUrl)('cross-service events over the postgres driver', () => {
  const handles: DatabaseHandle[] = [];
  const brokers: EventBroker[] = [];
  const subscriptions: Subscription[] = [];
  const apps: Array<{ close: () => Promise<void> }> = [];
  let storageRoot: string;

  /** A function's own pool and broker, built the way each service's index.ts builds them. */
  function openFunction(env: {
    DATABASE_URL: string;
    MESSAGING_DRIVER: 'memory' | 'rabbitmq' | 'postgres';
    RABBITMQ_URL?: string | undefined;
    MESSAGING_EXCHANGE: string;
    MESSAGING_MAX_RETRIES: number;
  }) {
    const handle = createDatabase({ url: env.DATABASE_URL, maxConnections: 4 });
    handles.push(handle);
    const broker = createBroker({
      driver: env.MESSAGING_DRIVER,
      url: env.RABBITMQ_URL,
      exchange: env.MESSAGING_EXCHANGE,
      maxRetries: env.MESSAGING_MAX_RETRIES,
      db: handle.db,
      logger,
    });
    brokers.push(broker);
    return { handle, broker };
  }

  const common = {
    DATABASE_URL: testDatabaseUrl as string,
    MESSAGING_DRIVER: 'postgres',
    SUPABASE_URL,
    CRON_SECRET,
    LOG_LEVEL: 'fatal',
  };

  // Seeded identities and the ids the flow produces.
  const userId = randomUUID();
  const email = `cross-service-${userId}@example.com`;
  const companyName = `Cross Service Co ${randomUUID().slice(0, 8)}`;
  let memberToken: string;
  let adminToken: string;
  let resumeId: string;
  let jobId: string;
  let companyId: string;
  let applicationId: string;
  let contactId: string;

  let admin: DatabaseHandle;
  let profile: ReturnType<typeof buildProfileApp>;
  let jobs: ReturnType<typeof buildJobsApp>;
  let applications: ReturnType<typeof buildApplicationsApp>;
  let matching: ReturnType<typeof buildMatchingApp>;
  let referrals: ReturnType<typeof buildReferralsApp>;
  let learning: ReturnType<typeof buildLearningApp>;
  let analytics: ReturnType<typeof buildAnalyticsApp>;

  async function resetConsumerRegistry(): Promise<void> {
    await admin.sql`delete from event_consumers where consumer in ${admin.sql(CONSUMERS)}`;
  }

  async function ownEvents(eventType?: string) {
    return admin.sql<{ event_id: string; trace_id: string; payload: Record<string, unknown> }[]>`
      select event_id, trace_id, payload from event_outbox
      where user_id = ${userId} ${eventType === undefined ? admin.sql`` : admin.sql`and event_type = ${eventType}`}
      order by created_at`;
  }

  async function deliveryStatuses(eventId: string): Promise<Record<string, string>> {
    const rows = await admin.sql<{ consumer: string; status: string }[]>`
      select consumer, status from event_deliveries where event_id = ${eventId}`;
    return Object.fromEntries(rows.map((row) => [row.consumer, row.status]));
  }

  const bearerSecret = { authorization: `Bearer ${CRON_SECRET}` };

  /** What Vercel Cron does: a GET to the service's own drain path, carrying the bearer secret. */
  const cronDrain = (app: typeof matching, service: string) =>
    app.inject({
      method: 'GET',
      url: `/internal/${service}/drain`,
      headers: bearerSecret,
    });

  beforeAll(async () => {
    await stubJwks();
    admin = createDatabase({ url: testDatabaseUrl as string, maxConnections: 3 });
    handles.push(admin);
    await resetConsumerRegistry();

    // public.users.user_id FKs to auth.users.id; inserting there fires
    // handle_new_user, which creates the matching public.users row itself.
    await admin.sql`
      insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: 'Cross Service User' })}::jsonb, now(), now())`;
    memberToken = await signTestToken({ sub: userId, role: null, email });
    adminToken = await signTestToken({ sub: userId, role: 'admin', email });

    storageRoot = await mkdtemp(join(tmpdir(), 'atlas-cross-service-'));
    const storage = createStorage({ driver: 'local', localRoot: storageRoot });

    // --- producer-side functions: no consumers registered --------------------
    const profileEnv = loadProfileServiceEnv({ ...common, PORT: '4002' });
    const profileFn = openFunction(profileEnv);
    profile = buildProfileApp({
      db: profileFn.handle.db,
      sql: profileFn.handle.sql,
      env: profileEnv,
      logger,
      broker: profileFn.broker,
      storage,
      tokenVerifier: createTokenVerifierConfig(profileEnv),
    });

    const jobsEnv = loadJobsServiceEnv({ ...common, PORT: '4003' });
    const jobsFn = openFunction(jobsEnv);
    jobs = buildJobsApp({
      db: jobsFn.handle.db,
      sql: jobsFn.handle.sql,
      env: jobsEnv,
      logger,
      broker: jobsFn.broker,
      tokenVerifier: createTokenVerifierConfig(jobsEnv),
    });

    const applicationsEnv = loadApplicationsServiceEnv({ ...common, PORT: '4005' });
    const applicationsFn = openFunction(applicationsEnv);
    applications = buildApplicationsApp({
      db: applicationsFn.handle.db,
      sql: applicationsFn.handle.sql,
      env: applicationsEnv,
      logger,
      broker: applicationsFn.broker,
      tokenVerifier: createTokenVerifierConfig(applicationsEnv),
    });

    // --- consumer-side functions: handlers registered, as index.ts does ------
    const matchingEnv = loadMatchingServiceEnv({ ...common, PORT: '4004' });
    const matchingFn = openFunction(matchingEnv);
    matching = buildMatchingApp({
      db: matchingFn.handle.db,
      sql: matchingFn.handle.sql,
      env: matchingEnv,
      logger,
      broker: matchingFn.broker,
    });
    subscriptions.push(
      ...(await registerMatchingConsumers({
        db: matchingFn.handle.db,
        broker: matchingFn.broker,
        logger,
      })),
    );

    const referralsEnv = loadReferralsServiceEnv({ ...common, PORT: '4006' });
    const referralsFn = openFunction(referralsEnv);
    referrals = buildReferralsApp({
      db: referralsFn.handle.db,
      sql: referralsFn.handle.sql,
      env: referralsEnv,
      logger,
      broker: referralsFn.broker,
      tokenVerifier: createTokenVerifierConfig(referralsEnv),
    });
    subscriptions.push(
      ...(await registerReferralsConsumers({
        db: referralsFn.handle.db,
        broker: referralsFn.broker,
        logger,
      })),
    );

    const learningEnv = loadLearningServiceEnv({ ...common, PORT: '4008' });
    const learningFn = openFunction(learningEnv);
    learning = buildLearningApp({
      db: learningFn.handle.db,
      sql: learningFn.handle.sql,
      env: learningEnv,
      logger,
      broker: learningFn.broker,
      tokenVerifier: createTokenVerifierConfig(learningEnv),
    });
    subscriptions.push(
      ...(await registerLearningConsumers({
        db: learningFn.handle.db,
        broker: learningFn.broker,
        logger,
      })),
    );

    const analyticsEnv = loadAnalyticsServiceEnv({ ...common, PORT: '4009' });
    const analyticsFn = openFunction(analyticsEnv);
    analytics = buildAnalyticsApp({
      db: analyticsFn.handle.db,
      sql: analyticsFn.handle.sql,
      env: analyticsEnv,
      logger,
      broker: analyticsFn.broker,
      tokenVerifier: createTokenVerifierConfig(analyticsEnv),
    });
    subscriptions.push(
      ...(await registerAnalyticsConsumers({
        db: analyticsFn.handle.db,
        broker: analyticsFn.broker,
        logger,
      })),
    );

    for (const app of [profile, jobs, applications, matching, referrals, learning, analytics]) {
      apps.push(app);
      await app.ready();
    }
  });

  afterAll(async () => {
    if (admin) {
      // Everything this run published carries the test user in its trace.
      const events = await admin.sql<{ event_id: string; trace_id: string }[]>`
        select event_id, trace_id from event_outbox where user_id = ${userId}`;
      const eventIds = events.map((event) => event.event_id);
      const traceIds = [...new Set(events.map((event) => event.trace_id))];
      if (eventIds.length > 0) {
        await admin.sql`delete from processed_events where event_id in ${admin.sql(eventIds)}`;
        await admin.sql`delete from analytics_events where trace_id in ${admin.sql(traceIds)}`;
        await admin.sql`delete from event_outbox where event_id in ${admin.sql(eventIds)}`;
      }
      await resetConsumerRegistry();
      await admin.sql`delete from applications where user_id = ${userId}`;
      await admin.sql`delete from job_scores where user_id = ${userId}`;
      if (companyId) {
        await admin.sql`delete from contacts where company_id = ${companyId}`;
        await admin.sql`delete from jobs where company_id = ${companyId}`;
        await admin.sql`delete from companies where company_id = ${companyId}`;
      }
      await admin.sql`delete from resumes where user_id = ${userId}`;
      // Cascades to public.users via the auth.users FK.
      await admin.sql`delete from auth.users where id = ${userId}`;
    }
    await Promise.all(subscriptions.map((subscription) => subscription.stop()));
    await Promise.all(apps.map((app) => app.close()));
    await Promise.all(brokers.map((broker) => broker.close()));
    await Promise.all(handles.map((handle) => handle.close()));
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('publishes resume.parsed from the profile function and nothing reaches a consumer yet', async () => {
    const resumeText = [
      'Ada Lovelace',
      '',
      'Summary',
      'Backend engineer with a focus on distributed systems.',
      '',
      'Experience',
      'Staff Engineer, Analytical Engines Inc',
      'Jan 2021 - Present',
      '- Cut P99 latency by 40% via a queue-based rewrite',
      '',
      'Skills',
      'TypeScript, PostgreSQL, Docker',
    ].join('\n');
    const boundary = 'cross-service-boundary';

    const response = await profile.inject({
      method: 'POST',
      url: '/v1/resumes',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartResume(boundary, 'resume.txt', resumeText),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe('parsed');
    resumeId = response.json().resume_id;

    const events = await ownEvents('resume.parsed');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ resume_id: resumeId, user_id: userId });
    // Durable, but the matching function has never run: no delivery exists yet.
    expect(await deliveryStatuses(events[0]?.event_id as string)).toEqual({});
  });

  it('publishes job.discovered from the jobs function', async () => {
    const response = await jobs.inject({
      method: 'POST',
      url: '/v1/jobs/ingest',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        postings: [
          {
            source: 'manual',
            external_id: `cross-service-${randomUUID()}`,
            title: 'Staff Backend Engineer',
            company_name: companyName,
            description:
              'Build distributed systems in TypeScript on PostgreSQL, shipped with Docker.',
            remote_type: 'Fully Remote',
            employment_type: 'Full-time',
            apply_url: 'https://example.com/apply/cross-service',
            location: 'Remote',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().inserted).toBe(1);

    const events = await ownEvents('job.discovered');
    expect(events).toHaveLength(1);
    jobId = (events[0]?.payload as { job_id: string }).job_id;
    companyId = (events[0]?.payload as { company_id: string }).company_id;
    expect(await deliveryStatuses(events[0]?.event_id as string)).toEqual({});

    // Nothing has been scored, so the user has no recommendations yet.
    const recommendations = await jobs.inject({
      method: 'GET',
      url: `/v1/jobs/recommendations?user_id=${userId}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(recommendations.statusCode).toBe(200);
    expect(recommendations.json().items).toEqual([]);
  });

  it('refuses to drain matching without the cron secret, and scores nothing', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong-secret-wrong-secret' }]) {
      const response = await matching.inject({ method: 'POST', url: '/internal/drain', headers });
      expect(response.statusCode).toBe(401);
    }
    const scores = await admin.sql`select 1 from job_scores where user_id = ${userId}`;
    expect(scores).toHaveLength(0);
  });

  it("scores the job and serves recommendations once matching's drain runs, though matching never ran before", async () => {
    const response = await cronDrain(matching, 'matching');
    expect(response.statusCode).toBe(200);
    expect(response.json().processed).toBeGreaterThanOrEqual(2);

    // job_scores was written by a function that did not publish either event.
    const scores = await admin.sql<{ score: number; model_version: string }[]>`
      select score, model_version from job_scores where user_id = ${userId} and job_id = ${jobId}`;
    expect(scores).toHaveLength(1);
    expect(scores[0]?.score).toBeGreaterThan(0);

    const recommendations = await jobs.inject({
      method: 'GET',
      url: `/v1/jobs/recommendations?user_id=${userId}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(recommendations.statusCode).toBe(200);
    const items = recommendations.json().items as Array<{ job: { job_id: string }; score: number }>;
    expect(items.map((item) => item.job.job_id)).toEqual([jobId]);
    expect(items[0]?.score).toBe(scores[0]?.score);

    // Both triggering deliveries are settled, and matching published job.scored in turn.
    const resumeEvent = (await ownEvents('resume.parsed'))[0];
    const jobEvent = (await ownEvents('job.discovered'))[0];
    expect(await deliveryStatuses(resumeEvent?.event_id as string)).toEqual({
      'matching-service.resume-parsed': 'done',
    });
    expect(await deliveryStatuses(jobEvent?.event_id as string)).toEqual({
      'matching-service.job-discovered': 'done',
    });
    expect((await ownEvents('job.scored')).length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent: draining again does nothing, and a redelivered event rescoring does not duplicate rows', async () => {
    const again = await cronDrain(matching, 'matching');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ processed: 0, failed: 0, dead: 0 });

    // Simulate the at-least-once duplicate: the delivery is run a second time.
    const resumeEvent = (await ownEvents('resume.parsed'))[0];
    await admin.sql`delete from processed_events where event_id = ${resumeEvent?.event_id as string}`;
    await admin.sql`update event_deliveries set status = 'pending', attempts = 0, next_attempt_at = now()
                    where event_id = ${resumeEvent?.event_id as string}`;
    const redelivered = await cronDrain(matching, 'matching');
    expect(redelivered.json().processed).toBe(1);

    const scores =
      await admin.sql`select 1 from job_scores where user_id = ${userId} and job_id = ${jobId}`;
    expect(scores).toHaveLength(1);
  });

  it('detects a referral and updates learning from application.created, each in its own function', async () => {
    const [contact] = await admin.sql<{ contact_id: string }[]>`
      insert into contacts (company_id, full_name, title, email, relevance_score, source)
      values (${companyId}, 'Grace Hopper', 'Engineering Manager', ${`grace-${userId}@example.com`}, 0.8, 'manual')
      returning contact_id`;
    contactId = contact?.contact_id as string;

    const created = await applications.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'idempotency-key': `cross-service-${userId}`,
      },
      payload: { job_id: jobId, resume_id: resumeId, mode: 'manual' },
    });
    expect(created.statusCode).toBe(201);
    applicationId = created.json().application.application_id;

    const applicationEvents = await ownEvents('application.created');
    expect(applicationEvents).toHaveLength(1);
    expect(applicationEvents[0]?.payload).toMatchObject({
      application_id: applicationId,
      job_id: jobId,
    });
    expect(await deliveryStatuses(applicationEvents[0]?.event_id as string)).toEqual({});

    const referralDrain = await cronDrain(referrals, 'referrals');
    expect(referralDrain.statusCode).toBe(200);
    expect(referralDrain.json().processed).toBeGreaterThanOrEqual(1);
    const detected = await ownEvents('referral.detected');
    expect(detected).toHaveLength(1);
    expect(detected[0]?.payload).toMatchObject({
      contact_id: contactId,
      company_id: companyId,
      user_id: userId,
      relevance_score: 0.8,
    });

    const learningDrain = await cronDrain(learning, 'learning');
    expect(learningDrain.statusCode).toBe(200);
    expect(learningDrain.json()).toMatchObject({
      processed: expect.any(Number),
      failed: 0,
      dead: 0,
    });

    expect(await deliveryStatuses(applicationEvents[0]?.event_id as string)).toEqual({
      'referrals-service.application-created': 'done',
      'learning-service.application-created': 'done',
    });
  });

  it('records the whole chain in analytics, including events other functions published while draining', async () => {
    const response = await cronDrain(analytics, 'analytics');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ failed: 0, dead: 0 });

    const recorded = await admin.sql<{ event_type: string }[]>`
      select event_type from analytics_events
      where trace_id in (select trace_id from event_outbox where user_id = ${userId})`;
    const types = new Set(recorded.map((row) => row.event_type));
    for (const expected of [
      'resume.parsed',
      'job.discovered',
      'job.scored',
      'application.created',
      'referral.detected',
    ]) {
      expect(types, `analytics should have recorded ${expected}`).toContain(expected);
    }

    // Redelivery to analytics is absorbed by processed_events: no duplicate rows.
    const before = recorded.length;
    await admin.sql`update event_deliveries set status = 'pending', attempts = 0, next_attempt_at = now()
                    where consumer = 'analytics-service.event-recorder'
                      and event_id in (select event_id from event_outbox where user_id = ${userId})`;
    const redelivered = await cronDrain(analytics, 'analytics');
    expect(redelivered.json()).toMatchObject({ failed: 0, dead: 0 });
    const after = await admin.sql`
      select 1 from analytics_events where trace_id in (select trace_id from event_outbox where user_id = ${userId})`;
    expect(after).toHaveLength(before);
  });

  it('leaves no delivery pending or dead for any event of the flow', async () => {
    const unsettled = await admin.sql<{ event_type: string; consumer: string; status: string }[]>`
      select o.event_type, d.consumer, d.status
      from event_deliveries d join event_outbox o on o.event_id = d.event_id
      where o.user_id = ${userId} and d.status <> 'done'`;
    expect(unsettled).toEqual([]);
  });
});
