import type { EventEnvelope, EventType, TraceContext } from '@atlas/types';

/**
 * Transport-agnostic event bus. Services depend on this interface, never on
 * amqplib directly, which is what lets every consumer test run in-process
 * without a broker (docs/13 § Principles).
 */
export interface EventBroker {
  publish(envelope: EventEnvelope): Promise<void>;
  subscribe(options: SubscribeOptions): Promise<Subscription>;
  /** True when the underlying transport is usable. Feeds /health. */
  isHealthy(): boolean;
  close(): Promise<void>;
}

export interface ConsumeContext {
  /** How many times this delivery has already been attempted. */
  attempt: number;
  trace: TraceContext;
}

export type EventHandler = (envelope: EventEnvelope, context: ConsumeContext) => Promise<void>;

export interface SubscribeOptions {
  /**
   * Stable name for this consumer. Used as the queue name and as the dedupe
   * scope in `processed_events`, so renaming it replays history.
   */
  consumer: string;
  eventTypes: EventType[];
  handler: EventHandler;
  maxRetries?: number;
}

export interface Subscription {
  consumer: string;
  stop: () => Promise<void>;
}

/** A message that exhausted its retries. Surfaced for DLQ inspection. */
export interface DeadLetter {
  envelope: EventEnvelope;
  consumer: string;
  attempts: number;
  error: string;
  deadLetteredAt: string;
}
