import { schema, type Database } from '@atlas/db';
import type { EventEnvelope } from '@atlas/types';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Records one event durably, exactly once per consumer, using the
 * `processed_events` table already reserved for this (docs/02, docs/06 §
 * Processing rules: "all external side effects must be idempotent"). The
 * dedupe check and the side effect share a transaction so a crash between
 * them can't produce a recorded-but-not-counted or counted-but-not-recorded
 * event; a duplicate delivery just rolls the whole transaction back and is
 * treated as a no-op, the same shape as every other unique-violation race in
 * this codebase.
 */
export async function recordEvent(db: Database, consumer: string, envelope: EventEnvelope): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.processedEvents).values({ eventId: envelope.event_id, consumer });
      await tx.insert(schema.analyticsEvents).values({
        organizationId: envelope.trace.organization_id,
        userId: envelope.trace.user_id,
        eventType: envelope.event_type,
        payload: envelope.payload as Record<string, unknown>,
        traceId: envelope.trace.trace_id,
      });
    });
  } catch (cause) {
    if ((cause as { code?: string }).code === UNIQUE_VIOLATION) return;
    throw cause;
  }
}
