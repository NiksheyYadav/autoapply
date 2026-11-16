import type { Database } from '@atlas/db';
import type { Logger } from '@atlas/utils';
import type { EventBroker } from './broker.js';
import { MemoryBroker } from './memory-broker.js';
import { PostgresBroker } from './postgres-broker.js';
import { RabbitMqBroker } from './rabbitmq-broker.js';

export * from './broker.js';
export * from './drain-auth.js';
export * from './envelope.js';
export { MemoryBroker } from './memory-broker.js';
export { PostgresBroker, sanitizeError } from './postgres-broker.js';
export type { PostgresBrokerOptions, PurgeOptions } from './postgres-broker.js';
export { RabbitMqBroker } from './rabbitmq-broker.js';

export interface BrokerFactoryOptions {
  driver: 'memory' | 'rabbitmq' | 'postgres';
  url?: string | undefined;
  exchange?: string | undefined;
  maxRetries?: number | undefined;
  /** The service's own database handle. Required for (and only used by) `postgres`. */
  db?: Database | undefined;
  logger: Logger;
}

/** Chooses a transport from config so services never branch on the driver. */
export function createBroker(options: BrokerFactoryOptions): EventBroker {
  if (options.driver === 'memory') {
    return new MemoryBroker({ defaultMaxRetries: options.maxRetries ?? 3 });
  }

  if (options.driver === 'postgres') {
    if (options.db === undefined) {
      throw new Error('A database handle is required when MESSAGING_DRIVER=postgres');
    }
    return new PostgresBroker({
      db: options.db,
      logger: options.logger,
      ...(options.maxRetries === undefined ? {} : { defaultMaxRetries: options.maxRetries }),
    });
  }

  if (options.url === undefined || options.url === '') {
    throw new Error('RABBITMQ_URL is required when MESSAGING_DRIVER=rabbitmq');
  }

  return new RabbitMqBroker({
    url: options.url,
    logger: options.logger,
    ...(options.exchange === undefined ? {} : { exchange: options.exchange }),
    ...(options.maxRetries === undefined ? {} : { defaultMaxRetries: options.maxRetries }),
  });
}
