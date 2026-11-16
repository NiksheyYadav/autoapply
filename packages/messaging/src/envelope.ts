import { createHash } from 'node:crypto';
import type { EventEnvelope, EventPayloadMap, EventType, TraceContext } from '@atlas/types';
import { eventPayloadSchema } from '@atlas/types';
import { newUuid } from '@atlas/utils';

/**
 * Builds a validated envelope. `event_id` doubles as the consumer-side
 * idempotency key, so republishing the same envelope is always safe
 * (docs/06 § Processing rules).
 *
 * A consumer that publishes follow-up events should pass `derivedEventId(...)`
 * as `eventId`: delivery is at-least-once, and a handler that runs again would
 * otherwise publish its follow-ups again under fresh ids.
 */
export function createEvent<K extends EventType>(
  eventType: K,
  payload: EventPayloadMap[K],
  trace: TraceContext,
  occurredAt: string = new Date().toISOString(),
  eventId: string = newUuid(),
): EventEnvelope<K> {
  // Validate at construction: a malformed event is a bug in the producer, and
  // finding it at publish time beats finding it in a consumer's DLQ.
  eventPayloadSchema(eventType).parse(payload);

  return {
    event_id: eventId,
    event_type: eventType,
    occurred_at: occurredAt,
    trace,
    payload,
  };
}

/** Fixed namespace for `derivedEventId`; any constant works, it only has to never change. */
const DERIVED_EVENT_NAMESPACE = Buffer.from('6f1d0c3ae2b94d7f8a5c9e04b7d31a62', 'hex');

/**
 * A deterministic UUID (version 5 layout) for an event a handler publishes
 * while processing `parentEventId`. `key` tells apart the several events one
 * handler can emit for one parent, e.g. `job.scored:<job_id>:<user_id>`. The
 * same parent and key always give the same id, so a redelivered parent event
 * re-publishes the very same envelopes, which the outbox drops as duplicates.
 */
export function derivedEventId(parentEventId: string, key: string): string {
  const hash = createHash('sha1')
    .update(DERIVED_EVENT_NAMESPACE)
    .update(`${parentEventId}:${key}`, 'utf8')
    .digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** RabbitMQ routing key for an event type. `job.discovered` → `job.discovered`. */
export function routingKeyFor(eventType: EventType): string {
  return eventType;
}
