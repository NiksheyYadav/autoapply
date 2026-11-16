/**
 * matching-service under at-least-once delivery: the same event can reach a
 * handler again (a retry after a failure part-way, an expired lease, two
 * drains racing) and a fan-out must be both repeatable and cheap.
 *
 * Runs against a private schema (see support/isolated-db.ts) so the 500-row
 * pools it seeds cannot leak into other suites. DB-backed tests self-skip when
 * ATLAS_TEST_DATABASE_URL is unset (see .env.example).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { derivedEventId, createEvent } from '@atlas/messaging';
import { schema } from '@atlas/db';
import type { EventEnvelope } from '@atlas/types';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import { upsertScores, type UpsertScoreInput } from '../src/repo/scores.js';
import { registerConsumers } from '../src/worker.js';
import {
  createIsolatedDatabase,
  deliver,
  newPostgresBroker,
  parsedProfile,
  seedJobs,
  seedParsedResumes,
  spyBroker,
  type IsolatedDatabase,
  type SpyBroker,
} from './support/isolated-db.js';

const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

const RESUME_CONSUMER = 'matching-service.resume-parsed';
const JOB_CONSUMER = 'matching-service.job-discovered';

/** The size of a full fan-out (`RESCORE_BATCH_LIMIT`). */
const FULL_POOL = 500;
/** At most 3 reads, 2 chunked upserts and 1 batch publish, with headroom; it used to be ~4 statements per pair. */
const STATEMENT_BUDGET = 8;

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

function jobDiscovered(jobId: string): EventEnvelope<'job.discovered'> {
  return createEvent(
    'job.discovered',
    {
      job_id: jobId,
      company_id: randomUUID(),
      source: 'manual',
      job_hash: randomUUID(),
      title: 'Engineer',
    },
    newTraceContext(),
  );
}

describe.skipIf(!testDatabaseUrl)('matching-service under at-least-once delivery', () => {
  let isolated: IsolatedDatabase;
  let spy: SpyBroker;

  const sql = () => isolated.handle.sql;

  beforeAll(async () => {
    isolated = await createIsolatedDatabase(testDatabaseUrl as string);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(async () => {
    await isolated.reset();
    spy = spyBroker(newPostgresBroker(isolated));
    await registerConsumers({ db: isolated.db, broker: spy, logger: createSilentLogger() });
  });

  async function scoreRows() {
    return sql()<
      {
        job_id: string;
        user_id: string;
        score: number;
        reasons: string[];
        skill_gaps: string[];
        model_version: string;
        scored_at: string;
      }[]
    >`select job_id, user_id, score, reasons, skill_gaps, model_version, scored_at::text as scored_at
      from job_scores order by job_id, user_id`;
  }

  async function scoredEvents() {
    return sql()<
      { event_id: string; payload: { job_id: string; user_id: string; score: number } }[]
    >`
      select event_id, payload from event_outbox where event_type = 'job.scored' order by event_id`;
  }

  /** Pairs published more than once: the double count analytics would see. */
  async function duplicatedPairs() {
    return sql()<{ job_id: string; user_id: string; copies: number }[]>`
      select payload->>'job_id' as job_id, payload->>'user_id' as user_id, count(*)::int as copies
      from event_outbox where event_type = 'job.scored'
      group by 1, 2 having count(*) > 1`;
  }

  describe('resume.parsed', () => {
    it('scores a full pool of 500 jobs in a bounded number of statements', async () => {
      const userId = randomUUID();
      const jobIds = await seedJobs(isolated, FULL_POOL);
      await seedParsedResumes(isolated, [userId]);
      const envelope = resumeParsed(userId);
      isolated.queries.length = 0;

      const startedAt = performance.now();
      await deliver(spy, RESUME_CONSUMER, envelope);
      const elapsedMs = performance.now() - startedAt;

      expect(isolated.queries.length).toBeLessThanOrEqual(STATEMENT_BUDGET);
      // Generous: the point is "seconds, not minutes", not a benchmark.
      expect(elapsedMs).toBeLessThan(5_000);

      expect(await scoreRows()).toHaveLength(FULL_POOL);
      const events = await scoredEvents();
      expect(events.map((event) => event.event_id).sort()).toEqual(
        jobIds
          .map((jobId) => derivedEventId(envelope.event_id, `job.scored:${jobId}:${userId}`))
          .sort(),
      );
      expect(events.every((event) => event.payload.user_id === userId)).toBe(true);
    });

    it('does nothing without a parsed resume', async () => {
      await seedJobs(isolated, 5);

      await deliver(spy, RESUME_CONSUMER, resumeParsed(randomUUID()));

      expect(await scoreRows()).toHaveLength(0);
      expect(await scoredEvents()).toHaveLength(0);
    });

    it('a redelivered event leaves the scores byte-identical and publishes nothing new', async () => {
      const userId = randomUUID();
      await seedJobs(isolated, 60);
      await seedParsedResumes(isolated, [userId]);
      const envelope = resumeParsed(userId);

      await deliver(spy, RESUME_CONSUMER, envelope);
      const scoresBefore = await scoreRows();
      const eventsBefore = await scoredEvents();
      await deliver(spy, RESUME_CONSUMER, envelope, 1);

      // scored_at included: an unchanged score is not rewritten at all.
      expect(await scoreRows()).toEqual(scoresBefore);
      expect(await scoredEvents()).toEqual(eventsBefore);
      expect(eventsBefore).toHaveLength(60);
    });

    it('a new resume.parsed event for the same user is a new scoring and publishes again', async () => {
      const userId = randomUUID();
      await seedJobs(isolated, 10);
      await seedParsedResumes(isolated, [userId]);

      await deliver(spy, RESUME_CONSUMER, resumeParsed(userId));
      await deliver(spy, RESUME_CONSUMER, resumeParsed(userId));

      expect(await scoreRows()).toHaveLength(10);
      expect(await scoredEvents()).toHaveLength(20);
    });

    it('the same event delivered to several handlers at once is processed as one', async () => {
      const userId = randomUUID();
      const jobIds = await seedJobs(isolated, FULL_POOL);
      await seedParsedResumes(isolated, [userId]);
      const envelope = resumeParsed(userId);

      await Promise.all(
        [1, 2, 3].map((attempt) => deliver(spy, RESUME_CONSUMER, envelope, attempt)),
      );

      expect(await scoreRows()).toHaveLength(FULL_POOL);
      expect(await scoredEvents()).toHaveLength(FULL_POOL);
      expect(await duplicatedPairs()).toEqual([]);
      expect(jobIds).toHaveLength(FULL_POOL);
    });

    it('a failure part-way and its retry converge on the uninterrupted result with no duplicate events', async () => {
      const [reference, interrupted] = [randomUUID(), randomUUID()];
      await seedJobs(isolated, FULL_POOL);
      // Seeded one at a time, both get the same profile, so both runs must score alike.
      await seedParsedResumes(isolated, [reference]);
      await seedParsedResumes(isolated, [interrupted]);

      await deliver(spy, RESUME_CONSUMER, resumeParsed(reference));

      const retried = resumeParsed(interrupted);
      spy.publishBudget = 137;
      await expect(deliver(spy, RESUME_CONSUMER, retried)).rejects.toThrow(
        'injected publish failure',
      );
      spy.publishBudget = Number.POSITIVE_INFINITY;
      await deliver(spy, RESUME_CONSUMER, retried, 1);

      const scores = await scoreRows();
      const byUser = (userId: string) =>
        scores
          .filter((row) => row.user_id === userId)
          .map(({ job_id, score, reasons, skill_gaps, model_version }) => ({
            job_id,
            score,
            reasons,
            skill_gaps,
            model_version,
          }));
      expect(byUser(interrupted)).toHaveLength(FULL_POOL);
      expect(byUser(interrupted)).toEqual(byUser(reference));

      const events = await scoredEvents();
      expect(events).toHaveLength(2 * FULL_POOL);
      expect(await duplicatedPairs()).toEqual([]);
      const scoreByJob = (userId: string) =>
        events
          .filter((event) => event.payload.user_id === userId)
          .map((event) => [event.payload.job_id, event.payload.score])
          .sort();
      expect(scoreByJob(interrupted)).toEqual(scoreByJob(reference));
    });
  });

  describe('job.discovered', () => {
    it('scores a full pool of 500 candidates in a bounded number of statements', async () => {
      const [jobId] = await seedJobs(isolated, 1);
      const userIds = Array.from({ length: FULL_POOL }, () => randomUUID());
      await seedParsedResumes(isolated, userIds);
      const envelope = jobDiscovered(jobId as string);
      isolated.queries.length = 0;

      const startedAt = performance.now();
      await deliver(spy, JOB_CONSUMER, envelope);
      const elapsedMs = performance.now() - startedAt;

      expect(isolated.queries.length).toBeLessThanOrEqual(STATEMENT_BUDGET);
      expect(elapsedMs).toBeLessThan(5_000);

      const scores = await scoreRows();
      expect(scores.map((row) => row.user_id).sort()).toEqual([...userIds].sort());
      expect((await scoredEvents()).map((event) => event.event_id).sort()).toEqual(
        userIds
          .map((userId) => derivedEventId(envelope.event_id, `job.scored:${jobId}:${userId}`))
          .sort(),
      );
    });

    it('ignores a job that is gone or no longer active', async () => {
      const [jobId] = await seedJobs(isolated, 1);
      await seedParsedResumes(isolated, [randomUUID()]);
      await sql()`update jobs set is_active = false where job_id = ${jobId as string}`;

      await deliver(spy, JOB_CONSUMER, jobDiscovered(jobId as string));
      await deliver(spy, JOB_CONSUMER, jobDiscovered(randomUUID()));

      expect(await scoreRows()).toHaveLength(0);
      expect(await scoredEvents()).toHaveLength(0);
    });

    it('scores a user once however many parsed resumes they have, from the latest one', async () => {
      const userId = randomUUID();
      const [jobId] = await seedJobs(isolated, 1);
      await seedParsedResumes(isolated, [userId]);
      // An older resume with no skills at all; the newer seeded one must win.
      await isolated.db.insert(schema.resumes).values({
        userId,
        storageUrl: 'x',
        originalFilename: 'old.txt',
        contentType: 'text/plain',
        byteSize: 10,
        contentHash: randomUUID(),
        status: 'parsed',
        parsedProfile: parsedProfile([], 0),
        parsedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });

      await deliver(spy, JOB_CONSUMER, jobDiscovered(jobId as string));

      const scores = await scoreRows();
      expect(scores).toHaveLength(1);
      // The seeded profile has react and python of the job's five skills; the empty old one would leave all five.
      expect(scores[0]?.skill_gaps).toEqual(['postgresql', 'go', 'kafka']);
      expect(await scoredEvents()).toHaveLength(1);
    });

    it('a failure part-way and its retry publish each pair exactly once', async () => {
      const [jobId] = await seedJobs(isolated, 1);
      const userIds = Array.from({ length: FULL_POOL }, () => randomUUID());
      await seedParsedResumes(isolated, userIds);
      const envelope = jobDiscovered(jobId as string);

      spy.publishBudget = 211;
      await expect(deliver(spy, JOB_CONSUMER, envelope)).rejects.toThrow(
        'injected publish failure',
      );
      spy.publishBudget = Number.POSITIVE_INFINITY;
      await deliver(spy, JOB_CONSUMER, envelope, 1);

      expect(await scoreRows()).toHaveLength(FULL_POOL);
      expect(await scoredEvents()).toHaveLength(FULL_POOL);
      expect(await duplicatedPairs()).toEqual([]);
    });

    it('the same event delivered to several handlers at once is processed as one', async () => {
      const [jobId] = await seedJobs(isolated, 1);
      await seedParsedResumes(
        isolated,
        Array.from({ length: 200 }, () => randomUUID()),
      );
      const envelope = jobDiscovered(jobId as string);

      await Promise.all([1, 2, 3].map((attempt) => deliver(spy, JOB_CONSUMER, envelope, attempt)));

      expect(await scoreRows()).toHaveLength(200);
      expect(await scoredEvents()).toHaveLength(200);
      expect(await duplicatedPairs()).toEqual([]);
    });
  });

  describe('overlapping fan-outs', () => {
    it('resume.parsed and job.discovered racing over the same pairs finish without deadlocks', async () => {
      const jobIds = await seedJobs(isolated, 40);
      const userIds = Array.from({ length: 40 }, () => randomUUID());
      await seedParsedResumes(isolated, userIds);

      await Promise.all([
        ...userIds.map((userId) => deliver(spy, RESUME_CONSUMER, resumeParsed(userId))),
        ...jobIds.map((jobId) => deliver(spy, JOB_CONSUMER, jobDiscovered(jobId))),
      ]);

      expect(await scoreRows()).toHaveLength(40 * 40);
      // Each pair was scored by two different events, so two events per pair.
      expect(await scoredEvents()).toHaveLength(2 * 40 * 40);
    });
  });

  describe('upsertScores', () => {
    function input(
      jobId: string,
      userId: string,
      score: number,
      reasons = ['r'],
    ): UpsertScoreInput {
      return { jobId, userId, score, reasons, skillGaps: ['g'], modelVersion: 'test-model' };
    }

    it('writes nothing for an unchanged pair and rewrites a changed one', async () => {
      const [a, b] = [randomUUID(), randomUUID()];
      const user = randomUUID();
      await upsertScores(isolated.db, [input(a, user, 0.5), input(b, user, 0.5)]);
      const first = await scoreRows();
      await new Promise((resolve) => setTimeout(resolve, 15));

      await upsertScores(isolated.db, [input(a, user, 0.5), input(b, user, 0.75)]);
      const second = await scoreRows();

      const find = (rows: typeof first, jobId: string) => rows.find((row) => row.job_id === jobId);
      expect(find(second, a)).toEqual(find(first, a));
      expect(find(second, b)?.score).toBeCloseTo(0.75);
      expect(find(second, b)?.scored_at).not.toBe(find(first, b)?.scored_at);
      expect(second).toHaveLength(2);
    });

    it('keeps the last of a pair given twice instead of failing the statement', async () => {
      const [job, user] = [randomUUID(), randomUUID()];

      await upsertScores(isolated.db, [input(job, user, 0.2), input(job, user, 0.9)]);

      const rows = await scoreRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.score).toBeCloseTo(0.9);
    });

    it('batches given in opposite orders do not deadlock', async () => {
      const user = randomUUID();
      const jobIds = Array.from({ length: 150 }, () => randomUUID());
      const rows = (score: number) => jobIds.map((jobId) => input(jobId, user, score));

      for (let round = 0; round < 6; round += 1) {
        const forward = rows(0.1 + round / 100);
        await Promise.all([
          upsertScores(isolated.db, forward),
          upsertScores(isolated.db, [...forward].reverse()),
        ]);
      }

      expect(await scoreRows()).toHaveLength(150);
    });
  });
});
