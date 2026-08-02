import {
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
