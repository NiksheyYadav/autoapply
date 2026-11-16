/**
 * learning-service under at-least-once delivery: `application.created` can
 * reach the handler again (a retry after a failure part-way, an expired lease,
 * two drains racing), and every application re-derives the metric, so the
 * recompute must stay one cheap query and its `learning.updated` must not be
 * published twice for one trigger.
 *
 * Runs against a private schema (see matching's support/isolated-db.ts).
 * DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@atlas/db';
import { createEvent, derivedEventId } from '@atlas/messaging';
import type { EventEnvelope } from '@atlas/types';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import {
  createIsolatedDatabase,
  deliver,
  newPostgresBroker,
  spyBroker,
  type IsolatedDatabase,
  type SpyBroker,
} from '../../matching/test/support/isolated-db.js';
import { computeLearningMetrics, summarizeGroups } from '../src/lib/metrics.js';
import {
  aggregateModelGroups,
  listApplicationPairs,
  listRecentScores,
} from '../src/repo/lookups.js';
import { registerConsumers } from '../src/worker.js';

const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const CONSUMER = 'learning-service.application-created';

interface SeedScore {
  modelVersion: string;
  score: number;
  applied: boolean;
}

describe.skipIf(!testDatabaseUrl)('learning-service under at-least-once delivery', () => {
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

  /** Scores, newest first by position, each optionally backed by an application. */
  async function seed(scores: SeedScore[]): Promise<void> {
    const now = Date.now();
    const rows = scores.map((entry, index) => ({
      jobId: randomUUID(),
      userId: randomUUID(),
      score: entry.score,
      modelVersion: entry.modelVersion,
      scoredAt: new Date(now - index * 1000).toISOString(),
      applied: entry.applied,
    }));
    for (let start = 0; start < rows.length; start += 250) {
      const chunk = rows.slice(start, start + 250);
      await isolated.db
        .insert(schema.jobScores)
        .values(chunk.map(({ applied: _applied, ...row }) => row));
      const applied = chunk.filter((row) => row.applied);
      if (applied.length > 0) {
        await isolated.db
          .insert(schema.applications)
          .values(
            applied.map((row) => ({
              userId: row.userId,
              jobId: row.jobId,
              mode: 'manual' as const,
              status: 'draft' as const,
              idempotencyKey: randomUUID(),
            })),
          );
      }
    }
  }

  /** Two models with a lift (applied jobs scored higher) and one with nothing applied. */
  const MIXED: SeedScore[] = [
    { modelVersion: 'model-a', score: 0.9, applied: true },
    { modelVersion: 'model-a', score: 0.8, applied: true },
    { modelVersion: 'model-a', score: 0.3, applied: false },
    { modelVersion: 'model-a', score: 0.2, applied: false },
    { modelVersion: 'model-b', score: 0.7, applied: true },
    { modelVersion: 'model-b', score: 0.5, applied: false },
    { modelVersion: 'model-c', score: 0.6, applied: false },
  ];

  function applicationCreated(): EventEnvelope<'application.created'> {
    const userId = randomUUID();
    return createEvent(
      'application.created',
      { application_id: randomUUID(), user_id: userId, job_id: randomUUID(), mode: 'manual' },
      newTraceContext({ user_id: userId }),
    );
  }

  async function updates() {
    return sql()<
      {
        event_id: string;
        payload: { model_version: string; samples: number; metric: string; value: number };
      }[]
    >`
      select event_id, payload from event_outbox where event_type = 'learning.updated' order by payload->>'model_version', event_id`;
  }

  async function duplicatedUpdates() {
    return sql()<{ model_version: string; trigger: string; copies: number }[]>`
      select payload->>'model_version' as model_version, trace_id as trigger, count(*)::int as copies
      from event_outbox where event_type = 'learning.updated'
      group by 1, 2 having count(*) > 1`;
  }

  describe('aggregateModelGroups', () => {
    it('agrees with the in-memory metric over the same rows', async () => {
      await seed(MIXED);

      const aggregated = summarizeGroups(await aggregateModelGroups(isolated.db));
      const inMemory = computeLearningMetrics(
        await listRecentScores(isolated.db),
        await listApplicationPairs(isolated.db),
      );

      const byModel = (metrics: typeof aggregated) =>
        [...metrics].sort((a, b) => a.modelVersion.localeCompare(b.modelVersion));
      expect(byModel(aggregated)).toHaveLength(3);
      for (const [index, expected] of byModel(inMemory).entries()) {
        const actual = byModel(aggregated)[index];
        expect(actual?.modelVersion).toBe(expected.modelVersion);
        expect(actual?.appliedSamples).toBe(expected.appliedSamples);
        expect(actual?.notAppliedSamples).toBe(expected.notAppliedSamples);
        for (const key of ['appliedMeanScore', 'notAppliedMeanScore', 'lift'] as const) {
          if (expected[key] === null) expect(actual?.[key]).toBeNull();
          else expect(actual?.[key]).toBeCloseTo(expected[key] as number, 6);
        }
      }
      const a = byModel(aggregated)[0];
      expect(a?.lift).toBeCloseTo(0.85 - 0.25, 6);
      expect(byModel(aggregated)[2]?.lift).toBeNull();
    });

    it('samples the same most recent scores as the in-memory path', async () => {
      await seed(MIXED);

      const aggregated = summarizeGroups(await aggregateModelGroups(isolated.db, 3));
      const inMemory = computeLearningMetrics(
        await listRecentScores(isolated.db, 3),
        await listApplicationPairs(isolated.db),
      );

      // Newest three are model-a: 0.9 and 0.8 applied, 0.3 not.
      expect(aggregated).toHaveLength(1);
      expect(aggregated[0]?.appliedSamples).toBe(2);
      expect(aggregated[0]?.notAppliedSamples).toBe(1);
      expect(aggregated[0]?.lift).toBeCloseTo(inMemory[0]?.lift as number, 6);
    });

    it('is the same single statement however many scores there are', async () => {
      await seed(
        Array.from({ length: 2_000 }, (_, index) => ({
          modelVersion: index % 2 === 0 ? 'model-a' : 'model-b',
          score: (index % 100) / 100,
          applied: index % 7 === 0,
        })),
      );
      isolated.queries.length = 0;

      const groups = await aggregateModelGroups(isolated.db);

      expect(isolated.queries).toHaveLength(1);
      expect(
        groups
          .map((group) => group.appliedCount + group.notAppliedCount)
          .reduce((a, b) => a + b, 0),
      ).toBe(2_000);
    });
  });

  describe('application.created', () => {
    it('publishes one learning.updated per model with a lift, keyed by the event and the model', async () => {
      await seed(MIXED);
      const envelope = applicationCreated();
      isolated.queries.length = 0;

      await deliver(spy, CONSUMER, envelope);

      // One aggregate read and one batch publish, whatever the number of rows.
      expect(isolated.queries).toHaveLength(2);
      const events = await updates();
      expect(events.map((event) => event.payload.model_version)).toEqual(['model-a', 'model-b']);
      expect(events.map((event) => event.event_id).sort()).toEqual(
        ['model-a', 'model-b']
          .map((model) => derivedEventId(envelope.event_id, `learning.updated:${model}:score_lift`))
          .sort(),
      );
      expect(events[0]?.payload).toMatchObject({ metric: 'score_lift', samples: 4 });
      expect(events[0]?.payload.value).toBeCloseTo(0.6, 6);
    });

    it('publishes nothing while there are no scores', async () => {
      await deliver(spy, CONSUMER, applicationCreated());

      expect(await updates()).toHaveLength(0);
    });

    it('a redelivered event publishes nothing new, a later application publishes again', async () => {
      await seed(MIXED);
      const envelope = applicationCreated();

      await deliver(spy, CONSUMER, envelope);
      await deliver(spy, CONSUMER, envelope, 1);
      expect(await updates()).toHaveLength(2);

      await deliver(spy, CONSUMER, applicationCreated());
      expect(await updates()).toHaveLength(4);
    });

    it('the same event delivered to several handlers at once publishes each update once', async () => {
      await seed(MIXED);
      const envelope = applicationCreated();

      await Promise.all([1, 2, 3, 4].map((attempt) => deliver(spy, CONSUMER, envelope, attempt)));

      expect(await updates()).toHaveLength(2);
      expect(await duplicatedUpdates()).toEqual([]);
    });

    it('a failure part-way and its retry publish each update exactly once', async () => {
      await seed(MIXED);
      const envelope = applicationCreated();

      spy.publishBudget = 1;
      await expect(deliver(spy, CONSUMER, envelope)).rejects.toThrow('injected publish failure');
      spy.publishBudget = Number.POSITIVE_INFINITY;
      await deliver(spy, CONSUMER, envelope, 1);

      expect(await updates()).toHaveLength(2);
      expect(await duplicatedUpdates()).toEqual([]);
    });

    it('keeps the value an earlier attempt already published when a retry computes a newer one', async () => {
      await seed(MIXED);
      const envelope = applicationCreated();

      spy.publishBudget = 1;
      await expect(deliver(spy, CONSUMER, envelope)).rejects.toThrow('injected publish failure');
      const [first] = await updates();
      // The data moves on between the attempts: model-a gains a high-scoring skipped job.
      await seed([{ modelVersion: 'model-a', score: 1, applied: false }]);
      spy.publishBudget = Number.POSITIVE_INFINITY;
      await deliver(spy, CONSUMER, envelope, 1);

      const events = await updates();
      expect(events).toHaveLength(2);
      expect(events.find((event) => event.payload.model_version === 'model-a')).toEqual(first);
    });
  });
});
