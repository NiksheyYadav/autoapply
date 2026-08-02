import type { EventEnvelope, EventType } from '@atlas/types';
import { backoffDelayMs } from '@atlas/utils';
import type {
  ConsumeContext,
  DeadLetter,
  EventBroker,
  SubscribeOptions,
  Subscription,
} from './broker.js';

export interface MemoryBrokerOptions {
  defaultMaxRetries?: number;
  /** Injectable so tests do not actually wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
  onDeadLetter?: (letter: DeadLetter) => void;
}

interface Registration {
  options: SubscribeOptions;
  active: boolean;
}

/**
 * In-process broker used by tests and by single-process local development.
 * It reproduces the semantics that matter — at-least-once delivery, bounded
 * retries with backoff, and a dead-letter path — so consumer tests exercise
 * the same code paths they will hit against RabbitMQ.
 */
export class MemoryBroker implements EventBroker {
  private readonly registrations = new Map<string, Registration>();
  private readonly defaultMaxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onDeadLetter: ((letter: DeadLetter) => void) | undefined;

  readonly published: EventEnvelope[] = [];
  readonly deadLetters: DeadLetter[] = [];

  constructor(options: MemoryBrokerOptions = {}) {
    this.defaultMaxRetries = options.defaultMaxRetries ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onDeadLetter = options.onDeadLetter;
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    this.published.push(envelope);

    const matching = [...this.registrations.values()].filter(
      (registration) =>
        registration.active && registration.options.eventTypes.includes(envelope.event_type),
    );

    // Deliver to every consumer independently: one failing consumer must not
    // stop the others, mirroring separate RabbitMQ queues per consumer.
    await Promise.all(matching.map((registration) => this.deliver(registration, envelope)));
  }

  private async deliver(registration: Registration, envelope: EventEnvelope): Promise<void> {
    const maxRetries = registration.options.maxRetries ?? this.defaultMaxRetries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const context: ConsumeContext = { attempt, trace: envelope.trace };
      try {
        await registration.options.handler(envelope, context);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await this.sleep(backoffDelayMs(attempt));
        }
      }
    }

    const letter: DeadLetter = {
      envelope,
      consumer: registration.options.consumer,
      attempts: maxRetries + 1,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      deadLetteredAt: new Date().toISOString(),
    };
    this.deadLetters.push(letter);
    this.onDeadLetter?.(letter);
  }

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    if (this.registrations.has(options.consumer)) {
      throw new Error(`Consumer "${options.consumer}" is already subscribed`);
    }
    this.registrations.set(options.consumer, { options, active: true });

    return {
      consumer: options.consumer,
      stop: async () => {
        this.registrations.delete(options.consumer);
      },
    };
  }

  isHealthy(): boolean {
    return true;
  }

  async close(): Promise<void> {
    this.registrations.clear();
  }

  /** Test helper: everything published for a given event type. */
  publishedOf<K extends EventType>(eventType: K): EventEnvelope<K>[] {
    return this.published.filter(
      (envelope): envelope is EventEnvelope<K> => envelope.event_type === eventType,
    );
  }

  reset(): void {
    this.published.length = 0;
    this.deadLetters.length = 0;
  }
}
