import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import type { EventEnvelope } from '@atlas/types';
import { parseEvent } from '@atlas/types';
import { backoffDelayMs, type Logger } from '@atlas/utils';
import type {
  ConsumeContext,
  DeadLetter,
  EventBroker,
  SubscribeOptions,
  Subscription,
} from './broker.js';
import { routingKeyFor } from './envelope.js';

export interface RabbitMqBrokerOptions {
  url: string;
  exchange?: string;
  defaultMaxRetries?: number;
  logger: Logger;
  onDeadLetter?: (letter: DeadLetter) => void;
}

const ATTEMPT_HEADER = 'x-atlas-attempt';

/**
 * RabbitMQ transport for worker jobs and connector tasks (docs/06).
 *
 * Retry uses a per-consumer delay queue rather than immediate requeue:
 * requeuing hot-loops a failing message and starves the queue, whereas
 * dead-lettering into a TTL queue gives real backoff between attempts.
 */
export class RabbitMqBroker implements EventBroker {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private healthy = false;
  private readonly exchange: string;
  private readonly defaultMaxRetries: number;
  private readonly subscriptions = new Set<string>();

  constructor(private readonly options: RabbitMqBrokerOptions) {
    this.exchange = options.exchange ?? 'atlas.events';
    this.defaultMaxRetries = options.defaultMaxRetries ?? 5;
  }

  private async ensureChannel(): Promise<Channel> {
    if (this.channel !== null) return this.channel;

    const connection = await amqp.connect(this.options.url);
    connection.on('error', (error: unknown) => {
      this.healthy = false;
      this.options.logger.error({ err: error }, 'rabbitmq connection error');
    });
    connection.on('close', () => {
      this.healthy = false;
      this.channel = null;
      this.connection = null;
    });

    const channel = await connection.createChannel();
    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    // Bounded prefetch: without it a worker pulls the whole queue into memory
    // and loses every in-flight message when it restarts.
    await channel.prefetch(16);

    this.connection = connection;
    this.channel = channel;
    this.healthy = true;
    return channel;
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    const channel = await this.ensureChannel();
    const body = Buffer.from(JSON.stringify(envelope), 'utf8');

    channel.publish(this.exchange, routingKeyFor(envelope.event_type), body, {
      persistent: true,
      contentType: 'application/json',
      messageId: envelope.event_id,
      timestamp: Math.floor(new Date(envelope.occurred_at).getTime() / 1000),
      // Trace metadata travels with the message (docs/06 § Processing rules).
      headers: {
        'x-trace-id': envelope.trace.trace_id,
        'x-correlation-id': envelope.trace.correlation_id,
        'x-organization-id': envelope.trace.organization_id ?? '',
        'x-user-id': envelope.trace.user_id ?? '',
      },
    });
  }

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    if (this.subscriptions.has(options.consumer)) {
      throw new Error(`Consumer "${options.consumer}" is already subscribed`);
    }

    const channel = await this.ensureChannel();
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;

    const queue = `${options.consumer}.q`;
    const retryQueue = `${options.consumer}.retry`;
    const deadQueue = `${options.consumer}.dlq`;

    await channel.assertQueue(deadQueue, { durable: true });
    await channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange: '',
      deadLetterRoutingKey: deadQueue,
    });
    // Messages parked here expire back onto the work queue, giving delay
    // without holding an open timer in the worker process.
    await channel.assertQueue(retryQueue, {
      durable: true,
      deadLetterExchange: '',
      deadLetterRoutingKey: queue,
    });

    for (const eventType of options.eventTypes) {
      await channel.bindQueue(queue, this.exchange, routingKeyFor(eventType));
    }

    await channel.consume(queue, (message) => {
      if (message === null) return;
      void this.handleMessage(channel, message, options, maxRetries, retryQueue);
    });

    this.subscriptions.add(options.consumer);

    return {
      consumer: options.consumer,
      stop: async () => {
        this.subscriptions.delete(options.consumer);
      },
    };
  }

  private async handleMessage(
    channel: Channel,
    message: ConsumeMessage,
    options: SubscribeOptions,
    maxRetries: number,
    retryQueue: string,
  ): Promise<void> {
    const attempt = Number(message.properties.headers?.[ATTEMPT_HEADER] ?? 0);

    let envelope: EventEnvelope;
    try {
      envelope = parseEvent(JSON.parse(message.content.toString('utf8')));
    } catch (error) {
      // Unparseable payloads can never succeed on retry — dead-letter at once.
      this.options.logger.error(
        { err: error, consumer: options.consumer },
        'discarding unparseable message',
      );
      channel.nack(message, false, false);
      return;
    }

    const context: ConsumeContext = { attempt, trace: envelope.trace };

    try {
      await options.handler(envelope, context);
      channel.ack(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (attempt >= maxRetries) {
        this.options.logger.error(
          { consumer: options.consumer, event_id: envelope.event_id, attempts: attempt + 1 },
          'dead-lettering message after exhausting retries',
        );
        this.options.onDeadLetter?.({
          envelope,
          consumer: options.consumer,
          attempts: attempt + 1,
          error: errorMessage,
          deadLetteredAt: new Date().toISOString(),
        });
        channel.nack(message, false, false);
        return;
      }

      channel.sendToQueue(retryQueue, message.content, {
        persistent: true,
        expiration: String(backoffDelayMs(attempt)),
        headers: { ...message.properties.headers, [ATTEMPT_HEADER]: attempt + 1 },
      });
      channel.ack(message);
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async close(): Promise<void> {
    this.healthy = false;
    await this.channel?.close();
    await this.connection?.close();
    this.channel = null;
    this.connection = null;
  }
}
