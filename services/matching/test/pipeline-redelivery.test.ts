/**
 * The four event consumers end to end over the `postgres` driver, under the
 * deliveries it actually makes: the real services' `registerConsumers`, one
 * `PostgresBroker` per service as on Vercel, an event published once and
 * drained more than once — with a failure part-way, and with two drains
 * holding the same delivery at the same time.
 *
 * The per-service suites (at-least-once.test.ts in each) call a handler
 * directly; this one goes through the outbox, the leases and the retries, and
 * adds the consumer downstream of them all: analytics, which would count a
 * repeated `job.scored` (or any other derived event) twice.
 *
 * It reaches into services/* because this is the one place that sees all the
 * sides of an event; production code never imports across services. Runs
 * against a private schema (see support/isolated-db.ts), so it cannot pick up
 * — or be picked up by — another suite's outbox. DB-backed tests self-skip
 * when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@atlas/db';
import { createEvent } from '@atlas/messaging';
import type { EventEnvelope } from '@atlas/types';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import { registerConsumers as registerAnalytics } from '../../analytics/src/worker.js';
import { registerConsumers as registerLearning } from '../../learning/src/worker.js';
import { registerConsumers as registerReferrals } from '../../referrals/src/worker.js';
import { registerConsumers as registerMatching } from '../src/worker.js';
import {
  createIsolatedDatabase,
  newPostgresBroker,
  raceTwoDrains,
  seedJobs,
  seedParsedResumes,
  spyBroker,
  type IsolatedDatabase,
  type SpyBroker,
} from './support/isolated-db.js';

const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const logger = createSilentLogger();

describe.skipIf(!testDatabaseUrl)('event consumers over the postgres driver, redelivered', () => {
  let isolated: IsolatedDatabase;
  let matching: SpyBroker;
  let analytics: SpyBroker;
  const sql = () => isolated.handle.sql;

  /** One service's own broker, with that service's consumers registered the way its index.ts does. */
  async function service(
    register: (deps: {
      db: IsolatedDatabase['db'];
      broker: SpyBroker;
      logger: typeof logger;
    }) => Promise<unknown>,
  ) {
    const broker = spyBroker(newPostgresBroker(isolated, { retentionMs: 0 }));
    await register({ db: isolated.db, broker, logger });
    return broker;
  }

  beforeAll(async () => {
    isolated = await createIsolatedDatabase(testDatabaseUrl as string);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(async () => {
    await isolated.reset();
    matching = await service(registerMatching);
    analytics = await service(registerAnalytics);
  });

  /** Drains the given services until none has anything left to do. */
  async function settle(...brokers: SpyBroker[]): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      let work = 0;
      for (const broker of brokers) {
        const result = await broker.inner.drain({ limit: 1000, budgetMs: 20_000 });
        work += result.processed + result.failed + result.dead;
      }
      if (work === 0) return;
    }
    throw new Error('drains did not settle');
  }

  async function outboxCount(eventType: string): Promise<number> {
    const [row] = await sql()<
      { count: number }[]
    >`select count(*)::int as count from event_outbox where event_type = ${eventType}`;
    return row?.count ?? 0;
  }

  async function recordedCount(eventType: string): Promise<number> {
    const [row] = await sql()<
      { count: number }[]
    >`select count(*)::int as count from analytics_events where event_type = ${eventType}`;
    return row?.count ?? 0;
  }

  async function duplicatedPairs(eventType: string, ...keys: string[]) {
    const columns = keys.map((key) => `payload->>'${key}'`).join(', ');
    return sql().unsafe<{ copies: number }[]>(
      `select count(*)::int as copies from event_outbox where event_type = '${eventType}' group by ${columns} having count(*) > 1`,
    );
  }

  async function scoreSnapshot() {
    return sql()`select job_id, user_id, score, reasons, skill_gaps, model_version, scored_at::text as scored_at from job_scores order by job_id, user_id`;
  }

  function resumeParsed(userId: string): EventEnvelope<'resume.parsed'> {
    return createEvent(
      'resume.parsed',
      {
        resume_id: randomUUID(),
        user_id: userId,
        ats_score: 80,
        skill_count: 3,
        total_months_experience: 24,
      },
      newTraceContext({ user_id: userId }),
    );
  }

  describe('resume.parsed -> matching -> analytics', () => {
    const JOBS = 60;

    async function seedUser(): Promise<{
      userId: string;
      envelope: EventEnvelope<'resume.parsed'>;
    }> {
      const userId = randomUUID();
      await seedJobs(isolated, JOBS);
      await seedParsedResumes(isolated, [userId]);
      const envelope = resumeParsed(userId);
      await matching.inner.publish(envelope);
      return { userId, envelope };
    }

    it('published once and drained twice: one set of job.scored events and the same scores', async () => {
      await seedUser();

      const first = await matching.inner.drain();
      const scoresAfterFirst = await scoreSnapshot();
      const second = await matching.inner.drain();
      await settle(analytics);
      await settle(matching, analytics);

      expect(first).toMatchObject({ processed: 1, failed: 0, dead: 0 });
      expect(second).toMatchObject({ processed: 0, failed: 0, dead: 0 });
      expect(await scoreSnapshot()).toEqual(scoresAfterFirst);
      expect(scoresAfterFirst).toHaveLength(JOBS);
      expect(await outboxCount('job.scored')).toBe(JOBS);
      expect(await duplicatedPairs('job.scored', 'job_id', 'user_id')).toEqual([]);
      expect(await recordedCount('job.scored')).toBe(JOBS);
      expect(await recordedCount('resume.parsed')).toBe(1);
    });

    it('a drain that fails part-way and the drain that retries it leave one set of events', async () => {
      await seedUser();

      matching.publishBudget = 25;
      // One delivery per drain, so the first one fails and only the second retries it.
      const failed = await matching.inner.drain({ limit: 1 });
      matching.publishBudget = Number.POSITIVE_INFINITY;
      const retried = await matching.inner.drain({ limit: 1 });
      await settle(matching, analytics);

      expect(failed).toMatchObject({ processed: 0, failed: 1, dead: 0 });
      expect(retried).toMatchObject({ processed: 1, failed: 0, dead: 0 });
      expect(await scoreSnapshot()).toHaveLength(JOBS);
      expect(await outboxCount('job.scored')).toBe(JOBS);
      expect(await duplicatedPairs('job.scored', 'job_id', 'user_id')).toEqual([]);
      expect(await recordedCount('job.scored')).toBe(JOBS);
    });

    it('two drains holding the same delivery at once leave one set of events', async () => {
      await seedUser();

      const { handlerRuns } = await raceTwoDrains(isolated, (broker) =>
        registerMatching({ db: isolated.db, broker, logger }),
      );
      await settle(matching, analytics);

      expect(handlerRuns).toBe(2);
      expect(await scoreSnapshot()).toHaveLength(JOBS);
      expect(await outboxCount('job.scored')).toBe(JOBS);
      expect(await duplicatedPairs('job.scored', 'job_id', 'user_id')).toEqual([]);
      expect(await recordedCount('job.scored')).toBe(JOBS);
    });
  });

  describe('application.created -> referrals + learning -> analytics', () => {
    const CONTACTS = 3;

    async function seedApplication(): Promise<EventEnvelope<'application.created'>> {
      const companyId = randomUUID();
      const userId = randomUUID();
      const [job] = await isolated.db
        .insert(schema.jobs)
        .values({
          companyId,
          title: 'Backend Engineer',
          source: 'manual',
          jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        })
        .returning();
      const jobId = job?.jobId as string;
      const [application] = await isolated.db
        .insert(schema.applications)
        .values({ userId, jobId, mode: 'manual', status: 'draft', idempotencyKey: randomUUID() })
        .returning();
      await isolated.db.insert(schema.contacts).values(
        Array.from({ length: CONTACTS }, (_, index) => ({
          companyId,
          email: `contact-${index}-${randomUUID()}@example.com`,
          relevanceScore: 0.9 - index * 0.1,
        })),
      );
      // Applied-to job scored high, another scored low: a positive lift for one model.
      await isolated.db.insert(schema.jobScores).values([
        { jobId, userId, score: 0.9, modelVersion: 'model-x' },
        { jobId: randomUUID(), userId, score: 0.2, modelVersion: 'model-x' },
      ]);

      const envelope = createEvent(
        'application.created',
        {
          application_id: application?.applicationId as string,
          user_id: userId,
          job_id: jobId,
          mode: 'manual',
        },
        newTraceContext({ user_id: userId }),
      );
      await analytics.inner.publish(envelope);
      return envelope;
    }

    it('a drain that fails part-way and the drain that retries it publish each referral and update once', async () => {
      await seedApplication();
      const referrals = await service(registerReferrals);
      const learning = await service(registerLearning);

      referrals.publishBudget = 1;
      learning.publishBudget = 0;
      const failed = [
        await referrals.inner.drain({ limit: 1 }),
        await learning.inner.drain({ limit: 1 }),
      ];
      referrals.publishBudget = Number.POSITIVE_INFINITY;
      learning.publishBudget = Number.POSITIVE_INFINITY;
      await settle(referrals, learning, analytics);

      expect(failed.map((result) => result.failed)).toEqual([1, 1]);
      expect(await outboxCount('referral.detected')).toBe(CONTACTS);
      expect(await duplicatedPairs('referral.detected', 'contact_id', 'user_id')).toEqual([]);
      expect(await outboxCount('learning.updated')).toBe(1);
      expect(await recordedCount('application.created')).toBe(1);
      expect(await recordedCount('referral.detected')).toBe(CONTACTS);
      expect(await recordedCount('learning.updated')).toBe(1);
    });

    it('two drains holding the same delivery at once publish each referral and update once', async () => {
      await seedApplication();

      const referralsRace = await raceTwoDrains(isolated, (broker) =>
        registerReferrals({ db: isolated.db, broker, logger }),
      );
      const learningRace = await raceTwoDrains(isolated, (broker) =>
        registerLearning({ db: isolated.db, broker, logger }),
      );
      await settle(analytics);

      expect([referralsRace.handlerRuns, learningRace.handlerRuns]).toEqual([2, 2]);
      expect(await outboxCount('referral.detected')).toBe(CONTACTS);
      expect(await duplicatedPairs('referral.detected', 'contact_id', 'user_id')).toEqual([]);
      expect(await outboxCount('learning.updated')).toBe(1);
      expect(await recordedCount('referral.detected')).toBe(CONTACTS);
      expect(await recordedCount('learning.updated')).toBe(1);
    });
  });
});
