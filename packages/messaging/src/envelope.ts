import type { EventEnvelope, EventPayloadMap, EventType, TraceContext } from '@atlas/types';
import { eventPayloadSchema } from '@atlas/types';
import { newUuid } from '@atlas/utils';

/**
 * Builds a validated envelope. `event_id` doubles as the consumer-side
 * idempotency key, so republishing the same envelope is always safe
 * (docs/06 § Processing rules).
 */
export function createEvent<K extends EventType>(
  eventType: K,
  payload: EventPayloadMap[K],
  trace: TraceContext,
  occurredAt: string = new Date().toISOString(),
): EventEnvelope<K> {
  // Validate at construction: a malformed event is a bug in the producer, and
  // finding it at publish time beats finding it in a consumer's DLQ.
  eventPayloadSchema(eventType).parse(payload);

  return {
    event_id: newUuid(),
    event_type: eventType,
    occurred_at: occurredAt,
    trace,
    payload,
  };
}

/** RabbitMQ routing key for an event type. `job.discovered` → `job.discovered`. */
export function routingKeyFor(eventType: EventType): string {
  return eventType;
}
