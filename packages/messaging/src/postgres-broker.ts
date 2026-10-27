import { and, eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { parseEvent, type EventEnvelope } from '@atlas/types';
import { backoffDelayMs, type Logger } from '@atlas/utils';
import type {
  ConsumeContext,
  DeadLetter,
  DrainableBroker,
  DrainOptions,
  DrainResult,
  SubscribeOptions,
  Subscription,
} from './broker.js';

export interface PostgresBrokerOptions {
  /** The service's own handle; the outbox lives in the shared Postgres. */
  db: Database;
  logger: Logger;
  /** Retries after the first attempt (MESSAGING_MAX_RETRIES). Default 5. */
  defaultMaxRetries?: number;
  /**
   * How long a claimed delivery stays invisible to other drains. It must
   * exceed the longest a handler can run (Vercel's max duration is 30s), or a
   * slow handler would be run twice. A drain that crashes holds the delivery
   * for at most this long. Default 90s.
   */
  leaseMs?: number;
  /**
   * Assumed upper bound on how long a publish transaction can stay open. A
   * row can become visible after a drain already scanned past its position;
   * the overlap re-scans the trailing window so such a row is still picked up
   * (see `fanOut`). `publish` is a single autocommit INSERT, so milliseconds
   * is the real figure and the default of 60s is a wide margin.
   */
  visibilityOverlapMs?: number;
  /**
   * Delivered events older than this are removed at the end of a drain.
   * 0 disables the sweep (call `purge` yourself). Default 7 days — which is
   * also how long a consumer can be undeployed and still receive everything
   * published in the meantime.
   */
  retentionMs?: number;
  /** Backoff before retry number `retry` (0-based), in ms. Injectable for tests. */
  backoffMs?: (retry: number) => number;
  onDeadLetter?: (letter: DeadLetter) => void;
}

export interface PurgeOptions {
  /** Also remove events whose delivery to some consumer was dead-lettered. */
  includeDead?: boolean;
  /** Most events removed per call. Default 500. */
  limit?: number;
}

const EPOCH = '1970-01-01T00:00:00Z';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_VISIBILITY_OVERLAP_MS = 60_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DRAIN_LIMIT = 100;
const DEFAULT_DRAIN_BUDGET_MS = 20_000;
const FAN_OUT_BATCH = 500;
const DEFAULT_PURGE_LIMIT = 500;
const MAX_ERROR_LENGTH = 300;
/** Matches `varchar(160)` on `event_deliveries.consumer`. */
const MAX_CONSUMER_LENGTH = 160;

interface ConsumerState {
  /** Rows older than this are guaranteed to have a delivery for the consumer. */
  materializedThrough: string;
  /** Database clock at registration; every later statement runs after it. */
  snapshotAt: string;
}

interface ClaimedRow extends Record<string, unknown> {
  consumer: string;
  attempts: number;
  event_id: string;
  event_type: string;
  occurred_at: string;
  trace_id: string;
  correlation_id: string;
  organization_id: string | null;
  user_id: string | null;
  payload: unknown;
}

type Outcome = 'processed' | 'failed' | 'dead';

function inList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/**
 * One-line, bounded description of a failure that is safe to persist and to
 * show on a dashboard. drizzle wraps driver errors as `Failed query: <sql>
 * params: <values>`, and the bound values can be user data, so the underlying
 * cause is described instead; credentials, tokens and e-mail addresses that
 * still turn up in a message are masked.
 */
export function sanitizeError(error: unknown): string {
  let described: string;
  if (error instanceof Error) {
    const inner =
      error.message.startsWith('Failed query') && error.cause instanceof Error
        ? error.cause
        : error;
    described = `${inner.name}: ${inner.message}`;
  } else {
    described = String(error);
  }

  return (
    (described.split('\n')[0] ?? '')
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@\S+/gi, '[url]')
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[token]')
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, MAX_ERROR_LENGTH)
  );
}

/**
 * Event bus on a durable outbox in the shared Postgres, for serverless
 * deployments where no process stays alive to hold a consumer loop and the
 * in-memory driver's handlers only exist inside the publishing function.
 *
 * - `publish` is one INSERT (idempotent on `event_id`); once it returns the
 *   event is committed. It needs no long-lived connection.
 * - `subscribe` only registers the handler in this process. Nothing is
 *   delivered until something calls `drain`, which every consumer service
 *   exposes as `/internal/drain` for Vercel Cron.
 * - Fan-out happens at drain time, not publish time. A consumer's first drain
 *   registers it in `event_consumers` with a cursor at the epoch and creates
 *   deliveries for everything still in the outbox, so an event published
 *   before its consumer service had ever run is not lost — only an event that
 *   outlives the retention window without any drain is.
 * - Delivery is at-least-once: a handler can run again after a crash or an
 *   expired lease, so handlers must be idempotent (docs/06).
 */
export class PostgresBroker implements DrainableBroker {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly defaultMaxRetries: number;
  private readonly leaseMs: number;
  private readonly visibilityOverlapMs: number;
  private readonly retentionMs: number;
  private readonly backoffMs: (retry: number) => number;
  private readonly onDeadLetter: ((letter: DeadLetter) => void) | undefined;
  private readonly registrations = new Map<string, SubscribeOptions>();
  private closed = false;

  constructor(options: PostgresBrokerOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.defaultMaxRetries = options.defaultMaxRetries ?? DEFAULT_MAX_RETRIES;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.visibilityOverlapMs = options.visibilityOverlapMs ?? DEFAULT_VISIBILITY_OVERLAP_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.backoffMs = options.backoffMs ?? ((retry) => backoffDelayMs(retry));
    this.onDeadLetter = options.onDeadLetter;
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    this.assertOpen();
    // A malformed event is a producer bug; failing here beats a dead letter.
    const event = parseEvent(envelope);

    await this.db
      .insert(schema.eventOutbox)
      .values({
        eventId: event.event_id,
        eventType: event.event_type,
        occurredAt: event.occurred_at,
        traceId: event.trace.trace_id,
        correlationId: event.trace.correlation_id,
        organizationId: event.trace.organization_id,
        userId: event.trace.user_id,
        payload: event.payload as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: schema.eventOutbox.eventId });
  }

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    this.assertOpen();
    if (this.registrations.has(options.consumer)) {
      throw new Error(`Consumer "${options.consumer}" is already subscribed`);
    }
    if (options.consumer.length === 0 || options.consumer.length > MAX_CONSUMER_LENGTH) {
      throw new Error(`Consumer name must be 1-${MAX_CONSUMER_LENGTH} characters`);
    }
    if (options.eventTypes.length === 0) {
      throw new Error(`Consumer "${options.consumer}" must subscribe to at least one event type`);
    }

    this.registrations.set(options.consumer, options);
    return {
      consumer: options.consumer,
      stop: async () => {
        this.registrations.delete(options.consumer);
      },
    };
  }

  /**
   * Delivers due events to the handlers registered on this instance:
   * registers the consumers, fans new outbox rows out to them, then claims
   * and runs deliveries one at a time until `limit` deliveries have been
   * attempted, `budgetMs` has elapsed, or nothing is due. Safe to run
   * concurrently from any number of instances — a delivery is claimed with
   * `FOR UPDATE SKIP LOCKED` and leased, so exactly one drain runs it.
   */
  async drain(options: DrainOptions = {}): Promise<DrainResult> {
    this.assertOpen();
    const limit = options.limit ?? DEFAULT_DRAIN_LIMIT;
    const budgetMs = options.budgetMs ?? DEFAULT_DRAIN_BUDGET_MS;
    const startedAt = performance.now();
    const outOfTime = (): boolean => performance.now() - startedAt >= budgetMs;

    const result: DrainResult = { processed: 0, failed: 0, dead: 0, purged: 0 };
    const registrations = [...this.registrations.values()];
    if (registrations.length === 0) return result;

    const states = await this.registerConsumers(registrations);
    for (const registration of registrations) {
      if (outOfTime()) break;
      const state = states.get(registration.consumer);
      if (state !== undefined) await this.fanOut(registration, state, outOfTime);
    }

    const byName = new Map(
      registrations.map((registration) => [registration.consumer, registration]),
    );
    const names = [...byName.keys()];
    while (result.processed + result.failed + result.dead < limit && !outOfTime()) {
      const claimed = await this.claimNext(names);
      if (claimed === null) break;
      const registration = byName.get(claimed.consumer);
      if (registration === undefined) break;
      result[await this.deliver(registration, claimed)] += 1;
    }

    if (this.retentionMs > 0 && !outOfTime()) {
      result.purged = await this.purge(new Date(Date.now() - this.retentionMs));
    }
    return result;
  }

  /**
   * Removes outbox events (and, by cascade, their delivery rows) created
   * before `olderThan`, in batches. An event is kept while any delivery is
   * still `pending` (including a retry that is backing off), while a
   * registered consumer subscribed to its type has no delivery for it yet and
   * has not been fanned out past it (so it could still be owed the event),
   * and — unless `includeDead` — while any delivery is `dead`. Returns the
   * number of events removed.
   *
   * A consumer that is registered but permanently gone keeps its types from
   * being purged; remove its `event_consumers` row when decommissioning it.
   */
  async purge(olderThan: Date | string, options: PurgeOptions = {}): Promise<number> {
    this.assertOpen();
    const cutoff = typeof olderThan === 'string' ? olderThan : olderThan.toISOString();
    const rows = await this.db.execute(sql`
      WITH doomed AS (
        SELECT o.event_id
        FROM event_outbox o
        WHERE o.created_at < ${cutoff}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM event_deliveries d
            WHERE d.event_id = o.event_id
              AND (d.status = 'pending' OR (d.status = 'dead' AND NOT ${options.includeDead === true}::boolean))
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_consumers c
            WHERE o.event_type = ANY (c.event_types)
              AND c.materialized_through <= o.created_at
              AND NOT EXISTS (
                SELECT 1 FROM event_deliveries d2 WHERE d2.event_id = o.event_id AND d2.consumer = c.consumer
              )
          )
        ORDER BY o.created_at
        LIMIT ${options.limit ?? DEFAULT_PURGE_LIMIT}
        FOR UPDATE OF o SKIP LOCKED
      )
      DELETE FROM event_outbox WHERE event_id IN (SELECT event_id FROM doomed)
      RETURNING event_id
    `);
    return rows.length;
  }

  isHealthy(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    // The database handle belongs to the service that created it.
    this.closed = true;
    this.registrations.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('PostgresBroker is closed');
  }

  /**
   * Upserts this instance's consumers. A consumer new to the table starts at
   * the epoch (so it receives the whole retained history); one that has since
   * subscribed to an event type it did not have before is rewound to the epoch
   * too, which is harmless for the types it already had because delivery rows
   * are unique per (event, consumer).
   */
  private async registerConsumers(
    registrations: SubscribeOptions[],
  ): Promise<Map<string, ConsumerState>> {
    const table = schema.eventConsumers;
    const rows = await this.db
      .insert(table)
      .values(
        registrations.map((registration) => ({
          consumer: registration.consumer,
          eventTypes: [...registration.eventTypes],
        })),
      )
      .onConflictDoUpdate({
        target: table.consumer,
        set: {
          materializedThrough: sql`CASE WHEN ${table.eventTypes} @> excluded.event_types THEN ${table.materializedThrough} ELSE ${EPOCH}::timestamptz END`,
          eventTypes: sql`excluded.event_types`,
        },
      })
      .returning({
        consumer: table.consumer,
        materializedThrough: sql<string>`${table.materializedThrough}::text`,
        snapshotAt: sql<string>`now()::text`,
      });

    return new Map(
      rows.map((row) => [
        row.consumer,
        { materializedThrough: row.materializedThrough, snapshotAt: row.snapshotAt },
      ]),
    );
  }

  /**
   * Creates a `pending` delivery for `registration` for every outbox row of
   * its types at or after `state.materializedThrough`, in (created_at,
   * event_id) order and in bounded batches, then advances the cursor.
   *
   * Why the cursor trails the clock. `created_at` is the transaction start, a
   * row only becomes visible when it commits, and the scan reads whatever is
   * visible now. A row that commits after this scan therefore must not fall
   * behind the cursor, or it would never be delivered. A row invisible to a
   * statement that ran at time T committed after T, so its `created_at` is
   * later than T minus the longest publish transaction. The cursor is held at
   * T minus `visibilityOverlapMs` (and never past the last row scanned if the
   * pass was cut short), and the overlap window is simply scanned again next
   * time; `ON CONFLICT DO NOTHING` makes the repeat free of side effects.
   */
  private async fanOut(
    registration: SubscribeOptions,
    state: ConsumerState,
    outOfTime: () => boolean,
  ): Promise<void> {
    let afterCreatedAt = state.materializedThrough;
    let afterEventId = NIL_UUID;
    let lastScannedAt: string | null = null;
    let complete = false;

    while (!outOfTime()) {
      const batch = await this.db.execute<{ event_id: string; created_at: string }>(sql`
        WITH batch AS (
          SELECT event_id, created_at
          FROM event_outbox
          WHERE event_type IN (${inList(registration.eventTypes)})
            AND (created_at, event_id) > (${afterCreatedAt}::timestamptz, ${afterEventId}::uuid)
          ORDER BY created_at, event_id
          LIMIT ${FAN_OUT_BATCH}
        ), inserted AS (
          INSERT INTO event_deliveries (event_id, consumer, next_attempt_at)
          SELECT event_id, ${registration.consumer}::varchar, now() FROM batch
          ON CONFLICT (event_id, consumer) DO NOTHING
        )
        SELECT event_id, created_at::text AS created_at FROM batch ORDER BY created_at, event_id
      `);

      const last = batch[batch.length - 1];
      if (last !== undefined) {
        afterCreatedAt = last.created_at;
        afterEventId = last.event_id;
        lastScannedAt = last.created_at;
      }
      if (batch.length < FAN_OUT_BATCH) {
        complete = true;
        break;
      }
    }

    const bound = complete ? 'infinity' : (lastScannedAt ?? state.materializedThrough);
    await this.db.execute(sql`
      UPDATE event_consumers
      SET materialized_through = GREATEST(
            materialized_through,
            LEAST(
              ${state.snapshotAt}::timestamptz - make_interval(secs => ${this.visibilityOverlapMs / 1000}::double precision),
              ${bound}::timestamptz
            )
          ),
          last_drained_at = now()
      WHERE consumer = ${registration.consumer}
    `);
  }

  /**
   * Leases the oldest due delivery of any of `consumers`. `SKIP LOCKED` makes
   * concurrent claimers pass over each other's rows instead of waiting; the
   * lease (`locked_until`) then keeps the row claimed after this statement's
   * row lock is gone, while the handler runs outside any transaction.
   * `attempts` is bumped here, so a delivery that keeps crashing its drain
   * still runs out of retries.
   */
  private async claimNext(consumers: string[]): Promise<ClaimedRow | null> {
    const rows = await this.db.execute<ClaimedRow>(sql`
      WITH picked AS (
        SELECT event_id, consumer
        FROM event_deliveries
        WHERE consumer IN (${inList(consumers)})
          AND status = 'pending'
          AND next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until <= now())
        ORDER BY next_attempt_at, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE event_deliveries d
        SET attempts = d.attempts + 1,
            locked_until = now() + make_interval(secs => ${this.leaseMs / 1000}::double precision),
            updated_at = now()
        FROM picked
        WHERE d.event_id = picked.event_id AND d.consumer = picked.consumer
        RETURNING d.event_id, d.consumer, d.attempts
      )
      SELECT c.consumer,
             c.attempts,
             o.event_id,
             o.event_type,
             to_char(o.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
             o.trace_id,
             o.correlation_id,
             o.organization_id,
             o.user_id,
             o.payload
      FROM claimed c
      JOIN event_outbox o ON o.event_id = c.event_id
    `);
    return rows[0] ?? null;
  }

  private async deliver(registration: SubscribeOptions, claimed: ClaimedRow): Promise<Outcome> {
    let envelope: EventEnvelope;
    try {
      envelope = parseEvent({
        event_id: claimed.event_id,
        event_type: claimed.event_type,
        occurred_at: claimed.occurred_at,
        trace: {
          trace_id: claimed.trace_id,
          correlation_id: claimed.correlation_id,
          organization_id: claimed.organization_id,
          user_id: claimed.user_id,
        },
        payload: claimed.payload,
      });
    } catch (error) {
      // An envelope that does not parse cannot succeed on retry.
      this.logger.error(
        { consumer: claimed.consumer, event_id: claimed.event_id },
        'dead-lettering unparseable outbox event',
      );
      return this.settle(claimed, 'dead', `unparseable envelope: ${sanitizeError(error)}`);
    }

    // A handler failure is recorded before the next attempt can start, so
    // reaching here with more attempts than the budget allows means earlier
    // attempts never reported back: the function was killed (timeout, OOM) while
    // running this very event. Do not run it again, or a poison event would
    // crash its drain every time the lease expires.
    if (claimed.attempts - 1 > this.maxRetriesFor(registration)) {
      return this.bury(
        claimed,
        envelope,
        'retries exhausted: earlier attempts never reported back (the function timed out or crashed)',
      );
    }

    try {
      // processed_events is the cross-driver record of "this consumer handled
      // this event"; honour it so a replayed or re-materialized delivery of
      // something already handled does not run its side effects again.
      if (await this.alreadyProcessed(claimed)) {
        return await this.complete(claimed);
      }
    } catch (error) {
      return this.retryOrBury(registration, claimed, envelope, error);
    }

    const context: ConsumeContext = { attempt: claimed.attempts - 1, trace: envelope.trace };
    try {
      await registration.handler(envelope, context);
    } catch (error) {
      return this.retryOrBury(registration, claimed, envelope, error);
    }

    return this.complete(claimed);
  }

  private async alreadyProcessed(claimed: ClaimedRow): Promise<boolean> {
    const [row] = await this.db
      .select({ eventId: schema.processedEvents.eventId })
      .from(schema.processedEvents)
      .where(
        and(
          eq(schema.processedEvents.eventId, claimed.event_id),
          eq(schema.processedEvents.consumer, claimed.consumer),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Records success: the `processed_events` row (idempotent — analytics
   * writes its own inside its handler, in the same transaction as its side
   * effect) and `done`, atomically. The update is fenced on `attempts`, so a
   * drain whose lease expired mid-handler cannot overwrite the state written
   * by whoever claimed the delivery next.
   */
  private async complete(claimed: ClaimedRow): Promise<Outcome> {
    try {
      const updated = await this.db.transaction(async (tx) => {
        await tx
          .insert(schema.processedEvents)
          .values({ eventId: claimed.event_id, consumer: claimed.consumer })
          .onConflictDoNothing();
        return tx
          .update(schema.eventDeliveries)
          .set({ status: 'done', lockedUntil: null, lastError: null, updatedAt: sql`now()` })
          .where(this.fence(claimed))
          .returning({ eventId: schema.eventDeliveries.eventId });
      });
      if (updated.length === 0) {
        this.logger.warn(
          { consumer: claimed.consumer, event_id: claimed.event_id },
          'delivery lease expired before completion; another drain owns it now',
        );
      }
      return 'processed';
    } catch (error) {
      // The handler succeeded but its completion could not be recorded. The
      // lease expires and the delivery runs again — the at-least-once case.
      this.logger.error(
        { err: error, consumer: claimed.consumer, event_id: claimed.event_id },
        'failed to record a successful delivery',
      );
      return 'failed';
    }
  }

  private async retryOrBury(
    registration: SubscribeOptions,
    claimed: ClaimedRow,
    envelope: EventEnvelope,
    error: unknown,
  ): Promise<Outcome> {
    const retry = claimed.attempts - 1;
    const description = sanitizeError(error);

    if (retry < this.maxRetriesFor(registration)) {
      return this.settle(claimed, 'failed', description, this.backoffMs(retry));
    }
    return this.bury(claimed, envelope, description);
  }

  private maxRetriesFor(registration: SubscribeOptions): number {
    return registration.maxRetries ?? this.defaultMaxRetries;
  }

  private async bury(
    claimed: ClaimedRow,
    envelope: EventEnvelope,
    description: string,
  ): Promise<Outcome> {
    this.logger.error(
      { consumer: claimed.consumer, event_id: claimed.event_id, attempts: claimed.attempts },
      'dead-lettering event after exhausting retries',
    );
    const outcome = await this.settle(claimed, 'dead', description);
    try {
      this.onDeadLetter?.({
        envelope,
        consumer: claimed.consumer,
        attempts: claimed.attempts,
        error: description,
        deadLetteredAt: new Date().toISOString(),
      });
    } catch (callbackError) {
      this.logger.error({ err: callbackError }, 'onDeadLetter callback threw');
    }
    return outcome;
  }

  /** Writes a failure: back to `pending` after `delayMs`, or `dead`. */
  private async settle(
    claimed: ClaimedRow,
    outcome: 'failed' | 'dead',
    description: string,
    delayMs = 0,
  ): Promise<Outcome> {
    try {
      await this.db
        .update(schema.eventDeliveries)
        .set({
          status: outcome === 'dead' ? 'dead' : 'pending',
          lastError: description,
          lockedUntil: null,
          nextAttemptAt: sql`now() + make_interval(secs => ${delayMs / 1000}::double precision)`,
          updatedAt: sql`now()`,
        })
        .where(this.fence(claimed));
    } catch (error) {
      // The lease will lapse and the delivery will be claimed again.
      this.logger.error(
        { err: error, consumer: claimed.consumer, event_id: claimed.event_id },
        'failed to record a failed delivery',
      );
    }
    return outcome;
  }

  private fence(claimed: ClaimedRow): SQL | undefined {
    return and(
      eq(schema.eventDeliveries.eventId, claimed.event_id),
      eq(schema.eventDeliveries.consumer, claimed.consumer),
      eq(schema.eventDeliveries.attempts, claimed.attempts),
      eq(schema.eventDeliveries.status, 'pending'),
    );
  }
}
