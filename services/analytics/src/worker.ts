import type { Database } from '@atlas/db';
import { type EventBroker, type Subscription } from '@atlas/messaging';
import { EVENT_TYPES, type EventEnvelope } from '@atlas/types';
import type { Logger } from '@atlas/utils';
import { recordEvent } from './repo/events.js';

export interface WorkerDeps {
  db: Database;
  broker: EventBroker;
  logger: Logger;
}

const CONSUMER = 'analytics-service.event-recorder';

/**
 * The one consumer subscribed to every event type — analytics-service's
 * whole job is being the durable record of everything that happens
 * elsewhere (docs/08 § analytics-service), decoupled from every producer.
 */
export async function registerConsumers(deps: WorkerDeps): Promise<Subscription[]> {
  const subscription = await deps.broker.subscribe({
    consumer: CONSUMER,
    eventTypes: [...EVENT_TYPES],
    handler: (envelope: EventEnvelope) => recordEvent(deps.db, CONSUMER, envelope),
  });
  return [subscription];
}
