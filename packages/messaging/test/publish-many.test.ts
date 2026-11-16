import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import type { EventEnvelope } from '@atlas/types';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import {
  createEvent,
  isBatchPublisher,
  MemoryBroker,
  PostgresBroker,
  publishAll,
  type EventBroker,
} from '../src/index.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

/** Same private-schema isolation as postgres-broker.test.ts: the outbox tables are shared with other suites. */
const SCHEMA = `atlas_msg_batch_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const TABLES = ['event_outbox', 'event_consumers', 'event_deliveries', 'processed_events'] as const;

function learningEvent(eventId?: string): EventEnvelope<'learning.updated'> {
  return createEvent(
    'learning.updated',
    { model_version: 'v-test', samples: 3, metric: 'score_lift', value: 0.25 },
    newTraceContext(),
    undefined,
    eventId,
  );
}

describe('publishAll without a batch path', () => {
  /** A broker with only `publish`, recording how many calls overlap. */
  function plainBroker(options: { failOn?: number } = {}) {
    const state = { started: 0, inFlight: 0, maxInFlight: 0, published: [] as string[] };
    const broker: EventBroker = {
      publish: async (envelope) => {
        state.started += 1;
        const mine = state.started;
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        state.inFlight -= 1;
        if (mine === options.failOn) throw new Error(`publish ${mine} failed`);
        state.published.push(envelope.event_id);
      },
      subscribe: async (subscribeOptions) => ({
        consumer: subscribeOptions.consumer,
        stop: async () => undefined,
      }),
      isHealthy: () => true,
      close: async () => undefined,
    };
    return { broker, state };
  }

  it('is not a batch publisher unless the driver says so', () => {
    expect(isBatchPublisher(plainBroker().broker)).toBe(false);
    expect(isBatchPublisher(new MemoryBroker())).toBe(false);
  });

  it('publishes every envelope with bounded concurrency', async () => {
    const { broker, state } = plainBroker();
    const envelopes = Array.from({ length: 40 }, () => learningEvent());

    await publishAll(broker, envelopes);

    expect(state.published.sort()).toEqual(envelopes.map((envelope) => envelope.event_id).sort());
    expect(state.maxInFlight).toBeGreaterThan(1);
    expect(state.maxInFlight).toBeLessThanOrEqual(8);
  });

  it('does nothing for no envelopes', async () => {
    const { broker, state } = plainBroker();

    await publishAll(broker, []);

    expect(state.started).toBe(0);
  });

  it('rejects with the first failure and starts nothing further', async () => {
    const { broker, state } = plainBroker({ failOn: 3 });

    await expect(
      publishAll(
        broker,
        Array.from({ length: 100 }, () => learningEvent()),
      ),
    ).rejects.toThrow('publish 3 failed');

    // The calls already in flight finish; no new one starts after the failure.
    expect(state.started).toBeLessThanOrEqual(3 + 8);
  });

  it('delivers to subscribers of an in-memory broker', async () => {
    const broker = new MemoryBroker();
    const received: string[] = [];
    await broker.subscribe({
      consumer: 'test.consumer',
      eventTypes: ['learning.updated'],
      handler: async (envelope) => {
        received.push(envelope.event_id);
      },
    });
    const envelopes = Array.from({ length: 12 }, () => learningEvent());

    await publishAll(broker, envelopes);

    expect(received.sort()).toEqual(envelopes.map((envelope) => envelope.event_id).sort());
  });
});

describe.skipIf(!testDatabaseUrl)('PostgresBroker.publishMany', () => {
  let admin: DatabaseHandle;
  let handle: DatabaseHandle;
  let broker: PostgresBroker;

  beforeAll(async () => {
    admin = createDatabase({ url: testDatabaseUrl as string, maxConnections: 2 });
    await admin.sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    for (const table of TABLES) {
      await admin.sql.unsafe(
        `CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    }
    const url = new URL(testDatabaseUrl as string);
    url.searchParams.set('search_path', `${SCHEMA},public`);
    handle = createDatabase({ url: url.toString(), maxConnections: 4 });
    broker = new PostgresBroker({ db: handle.db, logger: createSilentLogger() });
  });

  afterAll(async () => {
    await handle?.close();
    if (admin) {
      await admin.sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.close();
    }
  });

  beforeEach(async () => {
    await handle.sql.unsafe(`TRUNCATE ${SCHEMA}.event_outbox CASCADE`);
  });

  async function outboxIds(): Promise<string[]> {
    const rows = await handle.sql<
      { event_id: string }[]
    >`select event_id from event_outbox order by event_id`;
    return rows.map((row) => row.event_id);
  }

  it('is a batch publisher, and publishAll takes the batch path in one statement', async () => {
    const statements: string[] = [];
    const counting = new PostgresBroker({
      db: drizzle(handle.sql, {
        schema,
        logger: { logQuery: (query) => void statements.push(query) },
      }),
      logger: createSilentLogger(),
    });
    expect(isBatchPublisher(counting)).toBe(true);

    await publishAll(
      counting,
      Array.from({ length: 200 }, () => learningEvent()),
    );

    expect(statements).toHaveLength(1);
    expect(await outboxIds()).toHaveLength(200);
  });

  it('stores each envelope intact', async () => {
    const envelope = learningEvent();

    await broker.publishMany([envelope]);

    const [row] = await handle.sql<
      { event_type: string; trace_id: string; correlation_id: string; payload: unknown }[]
    >`
      select event_type, trace_id, correlation_id, payload from event_outbox where event_id = ${envelope.event_id}`;
    expect(row).toEqual({
      event_type: 'learning.updated',
      trace_id: envelope.trace.trace_id,
      correlation_id: envelope.trace.correlation_id,
      payload: envelope.payload,
    });
  });

  it('is idempotent on event_id, across calls and inside one batch', async () => {
    const [a, b] = [learningEvent(), learningEvent()];

    await broker.publishMany([a, b, a]);
    await broker.publishMany([b, a]);
    await broker.publish(a);

    expect(await outboxIds()).toEqual([a.event_id, b.event_id].sort());
  });

  it('writes more than one batch when there are many events', async () => {
    const envelopes = Array.from({ length: 1_203 }, () => learningEvent());

    await broker.publishMany(envelopes);

    expect(await outboxIds()).toEqual(envelopes.map((envelope) => envelope.event_id).sort());
  });

  it('validates every envelope before writing any', async () => {
    const good = learningEvent();
    const bad = {
      ...learningEvent(),
      payload: { model_version: 'v', samples: -1, metric: 'm', value: 0 },
    } as EventEnvelope;

    await expect(broker.publishMany([good, bad])).rejects.toThrow();

    expect(await outboxIds()).toEqual([]);
  });

  it('accepts an empty batch and refuses a closed broker', async () => {
    await broker.publishMany([]);
    expect(await outboxIds()).toEqual([]);

    const closed = new PostgresBroker({ db: handle.db, logger: createSilentLogger() });
    await closed.close();
    await expect(closed.publishMany([learningEvent()])).rejects.toThrow('closed');
  });
});
