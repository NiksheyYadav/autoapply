import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { taskStatusEnum } from './enums.js';
import { organizations, users } from './identity.js';

/**
 * Durable mirror of the RabbitMQ work queue. The broker moves the message;
 * this table is what makes retries, DLQ inspection, and "why did this never
 * run" answerable after the fact (docs/06).
 */
export const tasks = pgTable(
  'tasks',
  {
    taskId: uuid('task_id').primaryKey().defaultRandom(),
    taskType: varchar('task_type', { length: 120 }).notNull(),
    queueStatus: taskStatusEnum('queue_status').notNull().default('pending'),
    retryCount: integer('retry_count').notNull().default(0),
    maxRetries: integer('max_retries').notNull().default(5),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    lastError: text('last_error'),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'string' }),
    /** Worker instance id holding the lock; used to reap crashed workers. */
    lockedBy: varchar('locked_by', { length: 200 }),
    /** Next eligible run time — how backoff is expressed durably. */
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    traceId: varchar('trace_id', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('tasks_claim_idx').on(table.queueStatus, table.availableAt),
    index('tasks_type_idx').on(table.taskType),
    index('tasks_locked_idx').on(table.lockedAt),
  ],
);

/**
 * Partitioning by month is expected once this grows (docs/02 § Design notes);
 * the migration to a partitioned parent is deferred until there is data to
 * justify it.
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    eventId: uuid('event_id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.organizationId, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => users.userId, { onDelete: 'set null' }),
    eventType: varchar('event_type', { length: 120 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    traceId: varchar('trace_id', { length: 100 }),
    timestamp: timestamp('timestamp', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('analytics_events_org_time_idx').on(table.organizationId, table.timestamp),
    index('analytics_events_type_time_idx').on(table.eventType, table.timestamp),
  ],
);

/**
 * Consumer-side dedupe. A worker records the event id it has handled inside
 * the same transaction as its side effect, which is what makes "all external
 * side effects must be idempotent" enforceable rather than aspirational.
 */
export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: uuid('event_id').notNull(),
    consumer: varchar('consumer', { length: 160 }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The (event, consumer) pair *is* the row identity — a PK, not an index.
    primaryKey({ columns: [table.eventId, table.consumer] }),
    index('processed_events_processed_at_idx').on(table.processedAt),
  ],
);

/**
 * Durable event log behind the `postgres` messaging driver
 * (packages/messaging/src/postgres-broker.ts). `publish()` is one INSERT into
 * this table, so a publish that returned is committed; consumers are fanned
 * out to later, at drain time, from `event_consumers.materialized_through`.
 * That is what lets an event published before a consumer's service has ever
 * run still reach it. Rows are removed by the broker's `purge()`.
 *
 * `event_id` is the envelope's idempotency key, so republishing the same
 * envelope is a no-op. `created_at` is the database clock (never a service
 * clock): the drain cursor is defined over it.
 */
export const eventOutbox = pgTable(
  'event_outbox',
  {
    eventId: uuid('event_id').primaryKey(),
    eventType: varchar('event_type', { length: 120 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    // The envelope's trace context, flattened so "what happened to trace X" is
    // a plain indexed query. No FKs: the outbox must never block a user or
    // organization deletion.
    traceId: varchar('trace_id', { length: 100 }).notNull(),
    correlationId: varchar('correlation_id', { length: 100 }).notNull(),
    organizationId: uuid('organization_id'),
    userId: uuid('user_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Drain cursor order (created_at, event_id), also the purge scan.
    index('event_outbox_created_idx').on(table.createdAt, table.eventId),
    // Fan-out for consumers that subscribe to a few of the event types.
    index('event_outbox_type_created_idx').on(table.eventType, table.createdAt, table.eventId),
    index('event_outbox_trace_idx').on(table.traceId),
  ],
);

/**
 * One row per registered consumer name: which event types it listens to and
 * how far fan-out has progressed for it. A consumer registers itself on its
 * first drain, starting from the epoch, so it sees every event still in the
 * outbox regardless of when it was published. The invariant is "every outbox
 * row of a subscribed type with created_at < materialized_through has a
 * delivery row for this consumer"; the broker keeps it a safety overlap
 * behind the database clock so a late-committing publish cannot be skipped.
 * `purge()` never deletes a row at or after this mark for a subscribed type.
 */
export const eventConsumers = pgTable('event_consumers', {
  consumer: varchar('consumer', { length: 160 }).primaryKey(),
  eventTypes: text('event_types').array().notNull(),
  materializedThrough: timestamp('materialized_through', { withTimezone: true, mode: 'string' })
    .notNull()
    .default(sql`'1970-01-01T00:00:00Z'`),
  lastDrainedAt: timestamp('last_drained_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

/**
 * Per-consumer delivery state for one outbox event. `pending` rows are due at
 * `next_attempt_at` (retry backoff lives here) and are leased by setting
 * `locked_until`; `attempts` increments on every claim, which makes it both
 * the retry counter and the fencing token for the claimer's later write.
 * `dead` rows exhausted their retries and are kept for inspection/replay.
 */
export const eventDeliveries = pgTable(
  'event_deliveries',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => eventOutbox.eventId, { onDelete: 'cascade' }),
    consumer: varchar('consumer', { length: 160 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Sanitized and truncated by the broker — never a raw driver message. */
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.consumer] }),
    // The claim query: due pending work for a consumer, oldest first. Partial,
    // so the (large, append-only) done history never bloats the hot path.
    index('event_deliveries_claim_idx')
      .on(table.consumer, table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    index('event_deliveries_dead_idx')
      .on(table.consumer, table.updatedAt)
      .where(sql`${table.status} = 'dead'`),
    check('event_deliveries_status_check', sql`${table.status} IN ('pending', 'done', 'dead')`),
  ],
);

/**
 * Connector grants. The token itself lives in the secret store; only an opaque
 * reference is kept here (docs/02 § Design notes, docs/09 § Token handling).
 */
export const connectorAccounts = pgTable(
  'connector_accounts',
  {
    connectorAccountId: uuid('connector_account_id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.userId, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.organizationId, {
      onDelete: 'cascade',
    }),
    provider: varchar('provider', { length: 80 }).notNull(),
    /** Account id as known by the provider. */
    externalAccountId: varchar('external_account_id', { length: 300 }).notNull(),
    /** Pointer into AWS Secrets Manager — never the credential itself. */
    secretRef: varchar('secret_ref', { length: 400 }).notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    status: varchar('status', { length: 40 }).notNull().default('active'),
    /** Consent record required by docs/09 § Compliance posture. */
    consentGrantedAt: timestamp('consent_granted_at', { withTimezone: true, mode: 'string' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'string' }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('connector_accounts_provider_external_key').on(
      table.provider,
      table.externalAccountId,
    ),
    index('connector_accounts_user_idx').on(table.userId),
    index('connector_accounts_org_idx').on(table.organizationId),
  ],
);

/**
 * API-level idempotency for POST endpoints. Stores the first response so a
 * replayed request returns the original result instead of re-executing.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: varchar('key', { length: 200 }).notNull(),
    scope: varchar('scope', { length: 120 }).notNull(),
    userId: uuid('user_id').references(() => users.userId, { onDelete: 'cascade' }),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key] }),
    index('idempotency_keys_expires_idx').on(table.expiresAt),
  ],
);
