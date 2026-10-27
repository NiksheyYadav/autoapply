/**
 * analytics-service under at-least-once delivery. It is the one consumer that
 * dedupes by itself: `recordEvent` writes the `processed_events` row and the
 * `analytics_events` row in one transaction, so a second delivery of an
 * `event_id` hits the primary key and is dropped. These tests pin that down
 * for the cases the broker's lease does not cover (a lease that expired while
 * the handler was still running, so the same envelope is handled twice at once).
 *
 * Runs against a private schema (see matching's support/isolated-db.ts).
 * DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEvent } from '@atlas/messaging';
import type { EventEnvelope } from '@atlas/types';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import {
  createIsolatedDatabase,
  deliver,
  newPostgresBroker,
  raceTwoDrains,
  spyBroker,
  type IsolatedDatabase,
  type SpyBroker,
} from '../../matching/test/support/isolated-db.js';
import { registerConsumers } from '../src/worker.js';

const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const CONSUMER = 'analytics-service.event-recorder';

function jobScored(userId = randomUUID()): EventEnvelope<'job.scored'> {
  return createEvent(
    'job.scored',
    { job_id: randomUUID(), user_id: userId, score: 0.5, model_version: 'test-model' },
    newTraceContext({ user_id: userId }),
  );
}

describe.skipIf(!testDatabaseUrl)('analytics-service under at-least-once delivery', () => {
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

  async function recorded(): Promise<number> {
    const [row] = await sql()<
      { count: number }[]
    >`select count(*)::int as count from analytics_events`;
    return row?.count ?? 0;
  }

  async function processed(): Promise<number> {
    const [row] = await sql()<
      { count: number }[]
    >`select count(*)::int as count from processed_events where consumer = ${CONSUMER}`;
    return row?.count ?? 0;
  }

  it('records an event once however many times it is delivered in a row', async () => {
    const envelope = jobScored();

    for (let attempt = 0; attempt < 4; attempt += 1)
      await deliver(spy, CONSUMER, envelope, attempt);

    expect(await recorded()).toBe(1);
    expect(await processed()).toBe(1);
  });

  it('records an event once when it is delivered to several handlers at once, and none of them fails', async () => {
    const envelope = jobScored();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, attempt) => deliver(spy, CONSUMER, envelope, attempt)),
    );

    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(await recorded()).toBe(1);
    expect(await processed()).toBe(1);
  });

  it('counts distinct events separately even when everything but the id is equal', async () => {
    const userId = randomUUID();
    const first = jobScored(userId);
    const second = { ...first, event_id: randomUUID() };

    await Promise.all([deliver(spy, CONSUMER, first), deliver(spy, CONSUMER, second)]);

    expect(await recorded()).toBe(2);
    expect(await processed()).toBe(2);
  });

  it('records an event once when two drains race for the same delivery after a lease expired', async () => {
    const envelope = jobScored();
    await spy.inner.publish(envelope);

    const { handlerRuns } = await raceTwoDrains(isolated, (broker) =>
      registerConsumers({ db: isolated.db, broker, logger: createSilentLogger() }),
    );

    expect(handlerRuns).toBe(2);
    expect(await recorded()).toBe(1);
    expect(await processed()).toBe(1);
    const deliveries = await sql()<{ status: string }[]>`
      select status from event_deliveries where event_id = ${envelope.event_id} and consumer = ${CONSUMER}`;
    expect(deliveries.map((delivery) => delivery.status)).toEqual(['done']);
  });
});
