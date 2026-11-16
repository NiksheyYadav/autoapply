import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@atlas/db';
import type { EventEnvelope } from '@atlas/types';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import {
  createEvent,
  derivedEventId,
  isDrainableBroker,
  PostgresBroker,
  sanitizeError,
  type DeadLetter,
  type PostgresBrokerOptions,
} from '../src/index.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

/**
 * The broker is exercised against its own copy of the four tables in a
 * throwaway schema (the connection's search_path points at it). The real
 * tables are shared with every other test file and with the cross-service
 * test, whose consumers would otherwise pick up — and race with the cleanup
 * of — the events published here.
 */
const SCHEMA = `atlas_msg_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const TABLES = ['event_outbox', 'event_consumers', 'event_deliveries', 'processed_events'] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

function outreachEvent(
  channel: 'email' | 'linkedin' | 'sms' = 'email',
): EventEnvelope<'outreach.sent'> {
  return createEvent(
    'outreach.sent',
    { message_id: randomUUID(), user_id: randomUUID(), contact_id: null, channel },
    newTraceContext({ user_id: randomUUID() }),
  );
}

function learningEvent(): EventEnvelope<'learning.updated'> {
  return createEvent(
    'learning.updated',
    { model_version: 'v-test', samples: 3, metric: 'score_lift', value: 0.25 },
    newTraceContext(),
  );
}

describe('sanitizeError', () => {
  it('keeps a single bounded line and masks e-mail addresses, URLs with credentials and JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl';
    const text = sanitizeError(
      new Error(
        `failed for ada@example.com via postgres://user:hunter2@db.internal:5432/app with ${jwt}\nsecond line ${'x'.repeat(600)}`,
      ),
    );
    expect(text).not.toContain('\n');
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(jwt);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.startsWith('Error: failed for [email]')).toBe(true);
  });

  it('describes the underlying driver error instead of the statement and its bound values', () => {
    const wrapped = new Error(
      'Failed query: insert into "t" values ($1)\nparams: secret-user-data',
      {
        cause: new Error('duplicate key value violates unique constraint "t_pkey"'),
      },
    );
    const text = sanitizeError(wrapped);
    expect(text).toBe('Error: duplicate key value violates unique constraint "t_pkey"');
  });

  it('handles values that are not errors', () => {
    expect(sanitizeError('plain string\nwith newline')).toBe('plain string');
    expect(sanitizeError(undefined)).toBe('undefined');
  });
});

describe.skipIf(!testDatabaseUrl)('PostgresBroker', () => {
  let admin: DatabaseHandle;
  let handle: DatabaseHandle;

  const silent = createSilentLogger();
  function newBroker(overrides: Partial<PostgresBrokerOptions> = {}): PostgresBroker {
    // Zero backoff by default: a failed delivery is due again immediately, so
    // tests do not wait. Backoff itself is covered by its own test.
    return new PostgresBroker({ db: handle.db, logger: silent, backoffMs: () => 0, ...overrides });
  }

  function consumerName(label: string): string {
    return `test.${label}.${randomUUID().slice(0, 8)}`;
  }

  async function delivery(eventId: string, consumer: string) {
    const [row] = await handle.sql<
      { status: string; attempts: number; last_error: string | null; locked_until: string | null }[]
    >`select status, attempts, last_error, locked_until::text from event_deliveries where event_id = ${eventId} and consumer = ${consumer}`;
    return row;
  }

  async function makeDue(consumer: string): Promise<void> {
    await handle.sql`update event_deliveries set next_attempt_at = now() - interval '1 second' where consumer = ${consumer}`;
  }

  async function age(eventIds: string[], interval = '10 days'): Promise<void> {
    await handle.sql`update event_outbox set created_at = now() - ${interval}::interval where event_id in ${handle.sql(eventIds)}`;
  }

  async function outboxIds(): Promise<string[]> {
    const rows = await handle.sql<{ event_id: string }[]>`select event_id from event_outbox`;
    return rows.map((row) => row.event_id);
  }

  beforeAll(async () => {
    admin = createDatabase({ url: testDatabaseUrl as string, maxConnections: 2 });
    await admin.sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    for (const table of TABLES) {
      await admin.sql.unsafe(
        `CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    }
    await admin.sql.unsafe(
      `ALTER TABLE ${SCHEMA}.event_deliveries ADD FOREIGN KEY (event_id) REFERENCES ${SCHEMA}.event_outbox (event_id) ON DELETE CASCADE`,
    );

    const url = new URL(testDatabaseUrl as string);
    url.searchParams.set('search_path', `${SCHEMA},public`);
    handle = createDatabase({ url: url.toString(), maxConnections: 8 });
  });

  afterAll(async () => {
    await handle?.close();
    if (admin) {
      await admin.sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.close();
    }
  });

  beforeEach(async () => {
    await handle.sql.unsafe(`TRUNCATE ${TABLES.map((table) => `${SCHEMA}.${table}`).join(', ')}`);
  });

  it('runs against the private schema, not the shared tables', async () => {
    const [row] = await handle.sql<{ search_path: string }[]>`show search_path`;
    expect(row?.search_path).toContain(SCHEMA);
    const [resolved] = await handle.sql<{ schema: string }[]>`
      select n.nspname as schema from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.oid = to_regclass('event_outbox')`;
    expect(resolved?.schema).toBe(SCHEMA);
  });

  describe('delivery', () => {
    it('delivers a published envelope exactly once, intact, and records it in processed_events', async () => {
      const consumer = consumerName('once');
      const producer = newBroker();
      const worker = newBroker();
      const received: Array<{ envelope: EventEnvelope; attempt: number }> = [];
      await worker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async (envelope, context) => {
          received.push({ envelope, attempt: context.attempt });
        },
      });

      const published = [outreachEvent(), outreachEvent(), outreachEvent()];
      for (const event of published) await producer.publish(event);

      const first = await worker.drain();
      expect(first).toMatchObject({ processed: 3, failed: 0, dead: 0 });
      expect(received.map((r) => r.envelope.event_id).sort()).toEqual(
        published.map((e) => e.event_id).sort(),
      );
      // The envelope survives the round trip byte for byte, including trace.
      const sent = published[0] as EventEnvelope;
      const got = received.find((r) => r.envelope.event_id === sent.event_id);
      expect(got?.envelope).toEqual(sent);
      expect(got?.attempt).toBe(0);

      const second = await worker.drain();
      expect(second).toMatchObject({ processed: 0, failed: 0, dead: 0 });
      expect(received).toHaveLength(3);

      for (const event of published) {
        expect(await delivery(event.event_id, consumer)).toMatchObject({
          status: 'done',
          attempts: 1,
        });
      }
      const processed =
        await handle.sql`select 1 from processed_events where consumer = ${consumer}`;
      expect(processed).toHaveLength(3);
    });

    it('makes a duplicate publish of the same envelope a no-op', async () => {
      const consumer = consumerName('dup');
      const broker = newBroker();
      let calls = 0;
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => {
          calls += 1;
        },
      });

      const event = outreachEvent();
      await broker.publish(event);
      await broker.publish(event);
      expect(await outboxIds()).toEqual([event.event_id]);

      await broker.drain();
      expect(calls).toBe(1);
    });

    it('rejects an envelope whose payload does not match its type, before anything is stored', async () => {
      const broker = newBroker();
      const bad = {
        ...outreachEvent(),
        payload: { message_id: 'not-a-uuid' },
      } as unknown as EventEnvelope;
      await expect(broker.publish(bad)).rejects.toThrow();
      expect(await outboxIds()).toEqual([]);
    });

    it('fans one event out to every consumer subscribed to its type, and only those', async () => {
      const broker = newBroker();
      const calls: Record<string, string[]> = { a: [], b: [], c: [] };
      const [a, b, c] = [consumerName('a'), consumerName('b'), consumerName('c')];
      const handlerFor = (key: string) => async (envelope: EventEnvelope) => {
        calls[key]?.push(envelope.event_type);
      };
      await broker.subscribe({
        consumer: a,
        eventTypes: ['outreach.sent'],
        handler: handlerFor('a'),
      });
      await broker.subscribe({
        consumer: b,
        eventTypes: ['outreach.sent', 'learning.updated'],
        handler: handlerFor('b'),
      });
      await broker.subscribe({
        consumer: c,
        eventTypes: ['learning.updated'],
        handler: handlerFor('c'),
      });

      await broker.publish(outreachEvent());
      await broker.publish(learningEvent());

      const result = await broker.drain();
      expect(result.processed).toBe(4);
      expect(calls['a']).toEqual(['outreach.sent']);
      expect((calls['b'] ?? []).sort()).toEqual(['learning.updated', 'outreach.sent']);
      expect(calls['c']).toEqual(['learning.updated']);
    });

    it('delivers events published before the consumer existed, even though its service never ran', async () => {
      // Producer-side only: no consumer has ever been registered in this schema.
      const producer = newBroker();
      const early = [outreachEvent(), outreachEvent()];
      for (const event of early) await producer.publish(event);
      expect((await handle.sql`select 1 from event_consumers`).length).toBe(0);

      // The consumer's service starts for the first time, later.
      const late = newBroker();
      const seen: string[] = [];
      await late.subscribe({
        consumer: consumerName('late'),
        eventTypes: ['outreach.sent'],
        handler: async (envelope) => {
          seen.push(envelope.event_id);
        },
      });
      const afterwards = outreachEvent();
      await producer.publish(afterwards);

      const result = await late.drain();
      expect(result.processed).toBe(3);
      expect(seen.sort()).toEqual([...early, afterwards].map((e) => e.event_id).sort());
    });

    it('replays history for an event type a consumer newly subscribes to, without redelivering the rest', async () => {
      const consumer = consumerName('grow');
      const producer = newBroker();
      const outreach = outreachEvent();
      const learning = learningEvent();
      await producer.publish(outreach);
      await producer.publish(learning);

      const before = newBroker();
      const seenBefore: string[] = [];
      await before.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async (envelope) => {
          seenBefore.push(envelope.event_id);
        },
      });
      await before.drain();
      expect(seenBefore).toEqual([outreach.event_id]);

      // A new deployment of the same consumer now also wants learning.updated.
      const after = newBroker();
      const seenAfter: string[] = [];
      await after.subscribe({
        consumer,
        eventTypes: ['outreach.sent', 'learning.updated'],
        handler: async (envelope) => {
          seenAfter.push(envelope.event_id);
        },
      });
      const result = await after.drain();
      expect(result.processed).toBe(1);
      expect(seenAfter).toEqual([learning.event_id]);
    });

    it('fans out a backlog larger than one batch, including rows that share a created_at', async () => {
      const consumer = consumerName('backlog');
      const broker = newBroker();
      let handled = 0;
      await broker.subscribe({
        consumer,
        eventTypes: ['learning.updated'],
        handler: async () => {
          handled += 1;
        },
      });

      // 1100 rows with an identical created_at: the cursor must page through
      // them by (created_at, event_id), neither looping nor skipping.
      await handle.sql`
        insert into event_outbox (event_id, event_type, occurred_at, trace_id, correlation_id, payload, created_at)
        select gen_random_uuid(), 'learning.updated', now(), 'bulk', 'bulk',
               '{"model_version":"v","samples":1,"metric":"m","value":1}'::jsonb, now() - interval '5 minutes'
        from generate_series(1, 1100)`;

      const first = await broker.drain({ limit: 5 });
      expect(first.processed).toBe(5);
      const [count] = await handle.sql<
        { n: number }[]
      >`select count(*)::int as n from event_deliveries where consumer = ${consumer}`;
      expect(count?.n).toBe(1100);

      const rest = await broker.drain({ limit: 5000 });
      expect(rest.processed).toBe(1095);
      expect(handled).toBe(1100);
    });
  });

  describe('concurrency', () => {
    it('never double-processes when several drains run at once, across instances', async () => {
      const consumer = consumerName('race');
      const seen = new Map<string, number>();
      const handler = async (envelope: EventEnvelope): Promise<void> => {
        await sleep(3);
        seen.set(envelope.event_id, (seen.get(envelope.event_id) ?? 0) + 1);
      };

      // Three independent instances, as three warm functions would be.
      const workers = [newBroker(), newBroker(), newBroker()];
      for (const worker of workers) {
        await worker.subscribe({ consumer, eventTypes: ['outreach.sent'], handler });
      }
      const producer = newBroker();
      const published: EventEnvelope[] = [];
      for (let i = 0; i < 30; i += 1) {
        const event = outreachEvent();
        published.push(event);
        await producer.publish(event);
      }

      const results = await Promise.all(workers.map((worker) => worker.drain()));

      expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(30);
      expect(results.reduce((sum, r) => sum + r.failed + r.dead, 0)).toBe(0);
      expect(seen.size).toBe(30);
      for (const event of published) expect(seen.get(event.event_id)).toBe(1);
    });

    it('never double-processes when one instance drains concurrently with itself', async () => {
      const consumer = consumerName('self');
      const broker = newBroker();
      const seen = new Map<string, number>();
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async (envelope) => {
          await sleep(6);
          seen.set(envelope.event_id, (seen.get(envelope.event_id) ?? 0) + 1);
        },
      });
      for (let i = 0; i < 20; i += 1) await broker.publish(outreachEvent());

      const results = await Promise.all([broker.drain(), broker.drain(), broker.drain()]);

      expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(20);
      expect([...seen.values()].every((n) => n === 1)).toBe(true);
    });

    it('holds a claimed delivery for its lease, and fences out a drain whose lease lapsed mid-handler', async () => {
      const consumer = consumerName('lease');
      let calls = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handler = async (): Promise<void> => {
        calls += 1;
        if (calls === 1) await gate; // the first run hangs, as a stalled function would
      };
      const slow = newBroker();
      const other = newBroker();
      for (const broker of [slow, other]) {
        await broker.subscribe({ consumer, eventTypes: ['outreach.sent'], handler });
      }
      const event = outreachEvent();
      await slow.publish(event);

      const firstDrain = slow.drain();
      await waitFor(() => calls === 1);

      // Leased: a second drain finds nothing to do.
      expect(await other.drain()).toMatchObject({ processed: 0, failed: 0, dead: 0 });
      expect(calls).toBe(1);

      // The lease lapses (the first function was killed or is far too slow):
      // the delivery is claimed again. That is the at-least-once duplicate.
      await handle.sql`update event_deliveries set locked_until = now() - interval '1 second' where consumer = ${consumer}`;
      expect(await other.drain()).toMatchObject({ processed: 1 });
      expect(calls).toBe(2);
      expect(await delivery(event.event_id, consumer)).toMatchObject({
        status: 'done',
        attempts: 2,
      });

      // The stalled run finally finishes; its late write must not clobber the row.
      release();
      await firstDrain;
      expect(await delivery(event.event_id, consumer)).toMatchObject({
        status: 'done',
        attempts: 2,
      });
    });

    it('recovers a delivery whose drain crashed after claiming it, once the lease expires', async () => {
      const consumer = consumerName('crash');
      const broker = newBroker();
      let calls = 0;
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => {
          calls += 1;
        },
      });
      const event = outreachEvent();
      await broker.publish(event);
      await broker.drain({ limit: 1 }); // registers, fans out, runs it
      // Rewind the row to what a crash right after the claim leaves behind.
      await handle.sql`update event_deliveries set status = 'pending', attempts = 1, locked_until = now() + interval '1 minute' where consumer = ${consumer}`;
      await handle.sql`delete from processed_events where consumer = ${consumer}`;

      expect((await broker.drain()).processed).toBe(0);
      await handle.sql`update event_deliveries set locked_until = now() - interval '1 second' where consumer = ${consumer}`;
      expect((await broker.drain()).processed).toBe(1);
      expect(calls).toBe(2);
      expect(await delivery(event.event_id, consumer)).toMatchObject({
        status: 'done',
        attempts: 2,
      });
    });

    it('still delivers a row that commits after a drain has already scanned past its position', async () => {
      const consumer = consumerName('late-commit');
      const producer = newBroker();
      const worker = newBroker({ visibilityOverlapMs: 60_000 });
      const seen: string[] = [];
      await worker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async (envelope) => {
          seen.push(envelope.event_id);
        },
      });

      const slow = outreachEvent();
      const quick = outreachEvent();
      await handle.sql.begin(async (tx) => {
        // `slow` is inserted first but stays uncommitted ...
        await tx`insert into event_outbox (event_id, event_type, occurred_at, trace_id, correlation_id, payload)
                 values (${slow.event_id}, ${slow.event_type}, ${slow.occurred_at}, ${slow.trace.trace_id}, ${slow.trace.correlation_id},
                         ${JSON.stringify(slow.payload)}::jsonb)`;
        // ... while a later event commits and a drain scans past both positions.
        await producer.publish(quick);
        expect((await worker.drain()).processed).toBe(1);
      });
      expect(seen).toEqual([quick.event_id]);

      // `slow` is now committed, behind the point the first drain reached.
      expect((await worker.drain()).processed).toBe(1);
      expect(seen).toEqual([quick.event_id, slow.event_id]);
    });

    it('would skip that row with no overlap (control for the test above)', async () => {
      const consumer = consumerName('no-overlap');
      const producer = newBroker();
      const worker = newBroker({ visibilityOverlapMs: 0 });
      const seen: string[] = [];
      await worker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async (envelope) => {
          seen.push(envelope.event_id);
        },
      });

      const slow = outreachEvent();
      await handle.sql.begin(async (tx) => {
        await tx`insert into event_outbox (event_id, event_type, occurred_at, trace_id, correlation_id, payload)
                 values (${slow.event_id}, ${slow.event_type}, ${slow.occurred_at}, ${slow.trace.trace_id}, ${slow.trace.correlation_id},
                         ${JSON.stringify(slow.payload)}::jsonb)`;
        await producer.publish(outreachEvent());
        await worker.drain();
      });
      await worker.drain();
      expect(seen).not.toContain(slow.event_id);
    });
  });

  describe('failure handling', () => {
    it('retries with the configured backoff, hands the handler its attempt number, then dead-letters', async () => {
      const consumer = consumerName('dead');
      const deadLetters: DeadLetter[] = [];
      const broker = newBroker({
        backoffMs: (retry) => 60_000 * (retry + 1),
        onDeadLetter: (letter) => deadLetters.push(letter),
      });
      const attempts: number[] = [];
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        maxRetries: 2,
        handler: async (_envelope, context) => {
          attempts.push(context.attempt);
          throw new Error('downstream unavailable');
        },
      });
      const event = outreachEvent();
      await broker.publish(event);

      expect(await broker.drain()).toMatchObject({ processed: 0, failed: 1, dead: 0 });
      expect(await delivery(event.event_id, consumer)).toMatchObject({
        status: 'pending',
        attempts: 1,
        last_error: 'Error: downstream unavailable',
      });
      const [wait1] = await handle.sql<
        { s: number }[]
      >`select extract(epoch from next_attempt_at - now())::float as s from event_deliveries where consumer = ${consumer}`;
      expect(wait1?.s).toBeGreaterThan(50);
      expect(wait1?.s).toBeLessThanOrEqual(60);

      // Not due yet: nothing runs, and nothing is burned.
      expect(await broker.drain()).toMatchObject({ processed: 0, failed: 0, dead: 0 });
      expect(attempts).toEqual([0]);

      await makeDue(consumer);
      expect(await broker.drain()).toMatchObject({ failed: 1, dead: 0 });
      const [wait2] = await handle.sql<
        { s: number }[]
      >`select extract(epoch from next_attempt_at - now())::float as s from event_deliveries where consumer = ${consumer}`;
      expect(wait2?.s).toBeGreaterThan(110);
      expect(wait2?.s).toBeLessThanOrEqual(120);

      await makeDue(consumer);
      expect(await broker.drain()).toMatchObject({ failed: 0, dead: 1 });
      expect(await delivery(event.event_id, consumer)).toMatchObject({
        status: 'dead',
        attempts: 3,
      });
      expect(attempts).toEqual([0, 1, 2]);
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]).toMatchObject({
        consumer,
        attempts: 3,
        error: 'Error: downstream unavailable',
      });
      expect(deadLetters[0]?.envelope.event_id).toBe(event.event_id);

      // Dead is terminal.
      await makeDue(consumer);
      expect(await broker.drain()).toMatchObject({ processed: 0, failed: 0, dead: 0 });
      expect(attempts).toHaveLength(3);
    });

    it('buries a delivery whose earlier attempts never reported back, rather than crash-looping on it', async () => {
      const consumer = consumerName('poison');
      const deadLetters: DeadLetter[] = [];
      const broker = newBroker({ onDeadLetter: (letter) => deadLetters.push(letter) });
      let calls = 0;
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        maxRetries: 1,
        handler: async () => {
          calls += 1;
        },
      });
      const event = outreachEvent();
      await broker.publish(event);
      await broker.drain({ limit: 1 });
      expect(calls).toBe(1);

      // What a function killed mid-handler leaves behind: two claims, no result
      // written, lease long expired. maxRetries 1 allows two attempts in all.
      await handle.sql`update event_deliveries set status = 'pending', attempts = 2, locked_until = now() - interval '1 second' where consumer = ${consumer}`;
      await handle.sql`delete from processed_events where consumer = ${consumer}`;

      expect(await broker.drain()).toMatchObject({ processed: 0, failed: 0, dead: 1 });
      expect(calls).toBe(1);
      const row = await delivery(event.event_id, consumer);
      expect(row?.status).toBe('dead');
      expect(row?.last_error).toContain('retries exhausted');
      expect(deadLetters).toHaveLength(1);
    });

    it('survives an onDeadLetter callback that throws', async () => {
      const consumer = consumerName('bad-callback');
      const broker = newBroker({
        onDeadLetter: () => {
          throw new Error('callback exploded');
        },
      });
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        maxRetries: 0,
        handler: async () => {
          throw new Error('nope');
        },
      });
      const event = outreachEvent();
      await broker.publish(event);

      expect(await broker.drain()).toMatchObject({ dead: 1 });
      expect((await delivery(event.event_id, consumer))?.status).toBe('dead');
    });

    it('lets a delivery that fails transiently succeed on retry, clearing the error', async () => {
      const consumer = consumerName('flaky');
      const broker = newBroker();
      let calls = 0;
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => {
          calls += 1;
          if (calls === 1) throw new Error('transient');
        },
      });
      const event = outreachEvent();
      await broker.publish(event);

      expect(await broker.drain()).toMatchObject({ processed: 1, failed: 1, dead: 0 });
      expect(await delivery(event.event_id, consumer)).toMatchObject({
        status: 'done',
        attempts: 2,
        last_error: null,
      });
    });

    it('applies MESSAGING_MAX_RETRIES as the default retry budget', async () => {
      const consumer = consumerName('default-retries');
      const broker = newBroker({ defaultMaxRetries: 1 });
      let calls = 0;
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => {
          calls += 1;
          throw new Error('always');
        },
      });
      await broker.publish(outreachEvent());

      expect(await broker.drain()).toMatchObject({ processed: 0, failed: 1, dead: 1 });
      expect(calls).toBe(2);
    });

    it('does not let one failing consumer affect another consumer of the same event', async () => {
      const [bad, good] = [consumerName('bad'), consumerName('good')];
      const broker = newBroker();
      let goodCalls = 0;
      await broker.subscribe({
        consumer: bad,
        eventTypes: ['outreach.sent'],
        maxRetries: 0,
        handler: async () => {
          throw new Error('nope');
        },
      });
      await broker.subscribe({
        consumer: good,
        eventTypes: ['outreach.sent'],
        handler: async () => {
          goodCalls += 1;
        },
      });
      const event = outreachEvent();
      await broker.publish(event);

      expect(await broker.drain()).toMatchObject({ processed: 1, dead: 1 });
      expect(goodCalls).toBe(1);
      expect((await delivery(event.event_id, bad))?.status).toBe('dead');
      expect((await delivery(event.event_id, good))?.status).toBe('done');
    });

    it('stores a short, sanitized last_error rather than the raw message', async () => {
      const consumer = consumerName('sanitized');
      const broker = newBroker();
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => {
          throw new Error(
            `cannot email ada@example.com via postgres://svc:hunter2@db.internal/app\nstack frame\n${'y'.repeat(800)}`,
          );
        },
      });
      const event = outreachEvent();
      await broker.publish(event);
      await broker.drain({ limit: 1 });

      const row = await delivery(event.event_id, consumer);
      expect(row?.last_error).not.toBeNull();
      expect(row?.last_error).not.toContain('ada@example.com');
      expect(row?.last_error).not.toContain('hunter2');
      expect(row?.last_error).not.toContain('\n');
      expect((row?.last_error ?? '').length).toBeLessThanOrEqual(300);
    });

    it('dead-letters a stored envelope that no longer parses without calling the handler', async () => {
      const consumer = consumerName('unparseable');
      const broker = newBroker();
      let calls = 0;
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => {
          calls += 1;
        },
      });
      const id = randomUUID();
      await handle.sql`insert into event_outbox (event_id, event_type, occurred_at, trace_id, correlation_id, payload)
                       values (${id}, 'outreach.sent', now(), 't', 't', '{"nope":true}'::jsonb)`;

      expect(await broker.drain()).toMatchObject({ processed: 0, dead: 1 });
      expect(calls).toBe(0);
      const row = await delivery(id, consumer);
      expect(row?.status).toBe('dead');
      expect(row?.last_error).toContain('unparseable envelope');
    });

    it('skips a handler run for an event processed_events already records for that consumer', async () => {
      const consumer = consumerName('seen');
      const broker = newBroker();
      let calls = 0;
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => {
          calls += 1;
        },
      });
      const event = outreachEvent();
      await broker.publish(event);
      await handle.sql`insert into processed_events (event_id, consumer) values (${event.event_id}, ${consumer})`;

      expect(await broker.drain()).toMatchObject({ processed: 1 });
      expect(calls).toBe(0);
      expect((await delivery(event.event_id, consumer))?.status).toBe('done');
    });

    it('tolerates a handler that records processed_events itself (analytics does)', async () => {
      const consumer = consumerName('self-record');
      const broker = newBroker();
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async (envelope) => {
          await handle.sql`insert into processed_events (event_id, consumer) values (${envelope.event_id}, ${consumer})`;
        },
      });
      const event = outreachEvent();
      await broker.publish(event);

      expect(await broker.drain()).toMatchObject({ processed: 1, failed: 0, dead: 0 });
      expect((await delivery(event.event_id, consumer))?.status).toBe('done');
    });
  });

  describe('budget and limit', () => {
    it('stops starting new deliveries once the time budget is spent, leaving the rest pending', async () => {
      const consumer = consumerName('budget');
      const broker = newBroker();
      const seen = new Map<string, number>();
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async (envelope) => {
          await sleep(80);
          seen.set(envelope.event_id, (seen.get(envelope.event_id) ?? 0) + 1);
        },
      });
      for (let i = 0; i < 8; i += 1) await broker.publish(outreachEvent());

      const startedAt = Date.now();
      const limited = await broker.drain({ budgetMs: 100 });
      const tookMs = Date.now() - startedAt;
      expect(limited.processed).toBeGreaterThanOrEqual(1);
      expect(limited.processed).toBeLessThan(8);
      // Far less than the ~640ms the full backlog needs; one handler may overrun the budget.
      expect(tookMs).toBeLessThan(450);

      const [pending] = await handle.sql<
        { n: number }[]
      >`select count(*)::int as n from event_deliveries where consumer = ${consumer} and status = 'pending'`;
      expect(pending?.n).toBe(8 - limited.processed);

      const rest = await broker.drain();
      expect(limited.processed + rest.processed).toBe(8);
      expect([...seen.values()].every((n) => n === 1)).toBe(true);
      expect(seen.size).toBe(8);
    });

    it('honours the delivery limit', async () => {
      const consumer = consumerName('limit');
      const broker = newBroker();
      let calls = 0;
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => {
          calls += 1;
        },
      });
      for (let i = 0; i < 5; i += 1) await broker.publish(outreachEvent());

      expect((await broker.drain({ limit: 2 })).processed).toBe(2);
      expect(calls).toBe(2);
      expect((await broker.drain({ limit: 10 })).processed).toBe(3);
      expect(calls).toBe(5);
    });

    it('does no work, and touches no table, when nothing is subscribed', async () => {
      const broker = newBroker();
      await broker.publish(outreachEvent());
      expect(await broker.drain()).toEqual({ processed: 0, failed: 0, dead: 0, purged: 0 });
      expect((await handle.sql`select 1 from event_consumers`).length).toBe(0);
    });
  });

  describe('events published while draining', () => {
    it('lets a handler publish follow-up events, which their consumers receive on a later drain', async () => {
      const [first, second] = [consumerName('first'), consumerName('second')];
      const broker = newBroker();
      const followed: string[] = [];
      await broker.subscribe({
        consumer: first,
        eventTypes: ['outreach.sent'],
        handler: async (envelope) => {
          await broker.publish(
            createEvent(
              'learning.updated',
              { model_version: 'derived', samples: 1, metric: 'm', value: 1 },
              envelope.trace,
            ),
          );
        },
      });
      await broker.subscribe({
        consumer: second,
        eventTypes: ['learning.updated'],
        handler: async (envelope) => {
          followed.push(envelope.trace.trace_id);
        },
      });
      const trigger = outreachEvent();
      await broker.publish(trigger);

      // Fan-out happens before the handlers run, so the derived event waits for the next drain.
      expect((await broker.drain()).processed).toBe(1);
      expect(followed).toEqual([]);
      expect((await broker.drain()).processed).toBe(1);
      expect(followed).toEqual([trigger.trace.trace_id]);
    });
  });

  describe('redelivery of a parent event', () => {
    it('does not multiply follow-up events when they use derived ids', async () => {
      const [producer, follower] = [consumerName('producer'), consumerName('follower')];
      const broker = newBroker();
      let followed = 0;
      await broker.subscribe({
        consumer: producer,
        eventTypes: ['outreach.sent'],
        handler: async (envelope) => {
          await broker.publish(
            createEvent(
              'learning.updated',
              { model_version: 'derived', samples: 1, metric: 'm', value: 1 },
              envelope.trace,
              undefined,
              derivedEventId(envelope.event_id, 'learning.updated:derived'),
            ),
          );
        },
      });
      await broker.subscribe({
        consumer: follower,
        eventTypes: ['learning.updated'],
        handler: async () => {
          followed += 1;
        },
      });
      const parent = outreachEvent();
      await broker.publish(parent);
      await broker.drain();
      await broker.drain();
      expect(followed).toBe(1);

      // The parent is delivered to its consumer a second time (at-least-once).
      await handle.sql`delete from processed_events where consumer = ${producer}`;
      await handle.sql`update event_deliveries set status = 'pending', attempts = 0, next_attempt_at = now() where consumer = ${producer}`;
      expect((await broker.drain()).processed).toBe(1);
      await broker.drain();

      const derived =
        await handle.sql`select 1 from event_outbox where event_type = 'learning.updated'`;
      expect(derived).toHaveLength(1);
      expect(followed).toBe(1);
    });
  });

  describe('purge', () => {
    it('removes old delivered events but keeps pending, dead, undelivered and recent ones', async () => {
      const [p, q] = [consumerName('p'), consumerName('q')];
      const broker = newBroker();
      await broker.subscribe({
        consumer: p,
        eventTypes: ['outreach.sent'],
        maxRetries: 0,
        handler: async (envelope) => {
          if (envelope.payload && (envelope.payload as { channel: string }).channel === 'sms') {
            throw new Error('p rejects sms');
          }
        },
      });
      const broker2 = newBroker({ backoffMs: () => 60_000 });
      await broker2.subscribe({
        consumer: q,
        eventTypes: ['outreach.sent'],
        handler: async (envelope) => {
          if ((envelope.payload as { channel: string }).channel === 'linkedin') {
            throw new Error('q rejects linkedin');
          }
        },
      });

      const delivered = outreachEvent('email');
      const deadForP = outreachEvent('sms');
      const pendingForQ = outreachEvent('linkedin');
      const fresh = outreachEvent('email');
      const unwatched = learningEvent(); // no consumer subscribes to this type
      for (const event of [delivered, deadForP, pendingForQ, fresh, unwatched]) {
        await broker.publish(event);
      }
      await broker.drain();
      await broker2.drain();
      expect((await delivery(deadForP.event_id, p))?.status).toBe('dead');
      expect((await delivery(pendingForQ.event_id, q))?.status).toBe('pending');

      await age([delivered, deadForP, pendingForQ, unwatched].map((e) => e.event_id));
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

      expect(await broker.purge(cutoff)).toBe(2);
      expect((await outboxIds()).sort()).toEqual(
        [deadForP, pendingForQ, fresh].map((e) => e.event_id).sort(),
      );
      // Delivery rows go with their event.
      expect(await delivery(delivered.event_id, p)).toBeUndefined();
      expect(await delivery(delivered.event_id, q)).toBeUndefined();

      expect(await broker.purge(cutoff, { includeDead: true })).toBe(1);
      expect((await outboxIds()).sort()).toEqual(
        [pendingForQ, fresh].map((e) => e.event_id).sort(),
      );
      // Still retrying: never purged, however old.
      expect(await broker.purge(new Date())).toBe(1); // only `fresh` (delivered, now older than the cutoff)
      expect(await outboxIds()).toEqual([pendingForQ.event_id]);
    });

    it('keeps an event a registered consumer has not been fanned out to yet', async () => {
      const consumer = consumerName('dormant');
      const broker = newBroker();
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => undefined,
      });
      const event = outreachEvent();
      await broker.publish(event);
      await broker.drain();

      await age([event.event_id]);
      // The consumer's cursor is still at the epoch (it has never fanned out).
      await handle.sql`update event_consumers set materialized_through = '1970-01-01T00:00:00Z' where consumer = ${consumer}`;
      await handle.sql`delete from event_deliveries where consumer = ${consumer}`;
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(await broker.purge(cutoff)).toBe(0);

      await handle.sql`update event_consumers set materialized_through = now() where consumer = ${consumer}`;
      expect(await broker.purge(cutoff)).toBe(1);
    });

    it('honours the per-call limit', async () => {
      const broker = newBroker();
      const events = [outreachEvent(), outreachEvent(), outreachEvent()];
      for (const event of events) await broker.publish(event);
      await age(events.map((e) => e.event_id));

      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(await broker.purge(cutoff, { limit: 2 })).toBe(2);
      expect(await broker.purge(cutoff, { limit: 2 })).toBe(1);
    });

    it('runs as a bounded retention sweep at the end of a drain', async () => {
      const consumer = consumerName('sweep');
      const broker = newBroker({ retentionMs: 60_000 });
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => undefined,
      });
      const event = outreachEvent();
      await broker.publish(event);

      const first = await broker.drain();
      expect(first).toMatchObject({ processed: 1, purged: 0 });

      await age([event.event_id], '1 hour');
      const second = await broker.drain();
      expect(second.purged).toBe(1);
      expect(await outboxIds()).toEqual([]);
    });

    it('is disabled when retentionMs is 0', async () => {
      const consumer = consumerName('no-sweep');
      const broker = newBroker({ retentionMs: 0 });
      await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => undefined,
      });
      const event = outreachEvent();
      await broker.publish(event);
      await broker.drain();
      await age([event.event_id], '30 days');

      expect((await broker.drain()).purged).toBe(0);
      expect(await outboxIds()).toEqual([event.event_id]);
    });
  });

  describe('lifecycle', () => {
    it('rejects a duplicate consumer name and lets stop() release it', async () => {
      const consumer = consumerName('dupe-sub');
      const broker = newBroker();
      const subscription = await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => undefined,
      });
      await expect(
        broker.subscribe({
          consumer,
          eventTypes: ['outreach.sent'],
          handler: async () => undefined,
        }),
      ).rejects.toThrow(/already subscribed/);

      await subscription.stop();
      await expect(
        broker.subscribe({
          consumer,
          eventTypes: ['outreach.sent'],
          handler: async () => undefined,
        }),
      ).resolves.toMatchObject({ consumer });
    });

    it('rejects an empty subscription and an over-long consumer name', async () => {
      const broker = newBroker();
      await expect(
        broker.subscribe({
          consumer: consumerName('empty'),
          eventTypes: [],
          handler: async () => undefined,
        }),
      ).rejects.toThrow(/at least one event type/);
      await expect(
        broker.subscribe({
          consumer: 'x'.repeat(161),
          eventTypes: ['outreach.sent'],
          handler: async () => undefined,
        }),
      ).rejects.toThrow(/Consumer name/);
    });

    it('does not deliver to a subscription that was stopped', async () => {
      const consumer = consumerName('stopped');
      const broker = newBroker();
      let calls = 0;
      const subscription = await broker.subscribe({
        consumer,
        eventTypes: ['outreach.sent'],
        handler: async () => {
          calls += 1;
        },
      });
      await broker.publish(outreachEvent());
      await subscription.stop();

      expect(await broker.drain()).toMatchObject({ processed: 0 });
      expect(calls).toBe(0);
    });

    it('is drainable, reports healthy until closed, then refuses work', async () => {
      const broker = newBroker();
      expect(isDrainableBroker(broker)).toBe(true);
      expect(broker.isHealthy()).toBe(true);

      await broker.close();
      expect(broker.isHealthy()).toBe(false);
      await expect(broker.publish(outreachEvent())).rejects.toThrow(/closed/);
      await expect(broker.drain()).rejects.toThrow(/closed/);
      // close() does not close the caller's database handle.
      expect((await handle.sql`select 1 as ok`)[0]).toMatchObject({ ok: 1 });
    });
  });
});
