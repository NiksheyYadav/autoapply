import { eq, sql, type SQL } from 'drizzle-orm';
import { schema } from '@atlas/db';

/**
 * Rows that belong to a user without a foreign key to say so. Export and
 * deletion share these predicates so that "what we export" and "what we delete"
 * cannot drift apart.
 *
 * Event payloads carry the subject as `payload.user_id` (packages/types/src/events.ts),
 * and the envelope's trace context carries it as the `user_id` column, but for
 * some events only one of the two is set, so both count.
 */

/** Analytics events attributed to the user. `analytics_events.user_id` is a SET NULL foreign key, which would orphan, not remove, them. */
export function analyticsEventsOf(userId: string): SQL {
  return sql`(${eq(schema.analyticsEvents.userId, userId)} or ${schema.analyticsEvents.payload} ->> 'user_id' = ${userId})`;
}

/** Outbox events about the user. `event_outbox.user_id` deliberately has no foreign key (see the schema comment). */
export function outboxEventsOf(userId: string): SQL {
  return sql`(${eq(schema.eventOutbox.userId, userId)} or ${schema.eventOutbox.payload} ->> 'user_id' = ${userId})`;
}

/** Durable task rows whose payload names the user. Nothing writes this table yet; the predicate keeps it from becoming a retention gap. */
export function tasksOf(userId: string): SQL {
  return sql`${schema.tasks.payload} ->> 'user_id' = ${userId}`;
}
