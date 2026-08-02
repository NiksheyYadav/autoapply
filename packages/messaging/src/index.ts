import type { Logger } from '@atlas/utils';
import type { EventBroker } from './broker.js';
import { MemoryBroker } from './memory-broker.js';
import { RabbitMqBroker } from './rabbitmq-broker.js';

export * from './broker.js';
export * from './envelope.js';
export { MemoryBroker } from './memory-broker.js';
export { RabbitMqBroker } from './rabbitmq-broker.js';

export interface BrokerFactoryOptions {
  driver: 'memory' | 'rabbitmq';
  url?: string | undefined;
  exchange?: string | undefined;
  maxRetries?: number | undefined;
  logger: Logger;
}

/** Chooses a transport from config so services never branch on the driver. */
export function createBroker(options: BrokerFactoryOptions): EventBroker {
  if (options.driver === 'memory') {
    return new MemoryBroker({ defaultMaxRetries: options.maxRetries ?? 3 });
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
