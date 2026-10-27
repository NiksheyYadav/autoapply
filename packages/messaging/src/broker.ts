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

export interface DrainOptions {
  /** Most deliveries (processed + failed + dead) to attempt in one call. */
  limit?: number;
  /**
   * Wall-clock budget for the whole drain. It is checked between deliveries,
   * so a handler that is already running is allowed to finish; size it with
   * headroom under the function's max duration.
   */
  budgetMs?: number;
}

export interface DrainResult {
  /** Handler succeeded (or the delivery had already been recorded as processed). */
  processed: number;
  /** Handler threw and the delivery was rescheduled with backoff. */
  failed: number;
  /** Handler threw with no retries left; the delivery was dead-lettered. */
  dead: number;
  /** Old, fully delivered events removed by the opportunistic retention sweep. */
  purged: number;
}

/**
 * A broker with no resident consumer loop: `subscribe` only registers a
 * handler, and queued deliveries run when something calls `drain` (a Vercel
 * Cron hitting the service's /internal/drain route). Kept as a narrow
 * interface beside `EventBroker` so the memory and rabbitmq drivers are
 * untouched; use `isDrainableBroker` to narrow at runtime.
 */
export interface DrainableBroker extends EventBroker {
  drain(options?: DrainOptions): Promise<DrainResult>;
}

export function isDrainableBroker(broker: EventBroker): broker is DrainableBroker {
  return typeof (broker as Partial<DrainableBroker>).drain === 'function';
}

/** A message that exhausted its retries. Surfaced for DLQ inspection. */
export interface DeadLetter {
  envelope: EventEnvelope;
  consumer: string;
  attempts: number;
  error: string;
  deadLetteredAt: string;
}
