import type { Database } from '@atlas/db';
import {
  createEvent,
  derivedEventId,
  publishAll,
  type EventBroker,
  type Subscription,
} from '@atlas/messaging';
import type { EventEnvelope } from '@atlas/types';
import { childTrace, type Logger } from '@atlas/utils';
import { summarizeGroups } from './lib/metrics.js';
import { aggregateModelGroups } from './repo/lookups.js';

export interface WorkerDeps {
  db: Database;
  broker: EventBroker;
  logger: Logger;
}

const LIFT_METRIC = 'score_lift';

/**
 * A new application is itself an outcome signal, so this recomputes the
 * metric on every `application.created` — as a single aggregate query (see
 * `aggregateModelGroups`), not by loading rows, which is what keeps that
 * affordable and simpler than adding a separate scheduled job for an MVP.
 * Publishes one `learning.updated` per model version that has enough samples
 * to say something (both an applied and a not-applied group).
 *
 * Delivery is at-least-once, so this can run again for the same application.
 * Each update's id is derived from the triggering event, the model version and
 * the metric, so a repeat publishes the same envelope and the outbox drops it.
 * The first run's value stands even if a retry would compute a slightly newer
 * one; the next application refreshes it anyway.
 */
async function handleApplicationCreated(deps: WorkerDeps, envelope: EventEnvelope<'application.created'>) {
  const metrics = summarizeGroups(await aggregateModelGroups(deps.db));

  const occurredAt = new Date().toISOString();
  await publishAll(
    deps.broker,
    metrics.flatMap((metric) =>
      metric.lift === null
        ? []
        : [
            createEvent(
              'learning.updated',
              {
                model_version: metric.modelVersion,
                samples: metric.appliedSamples + metric.notAppliedSamples,
                metric: LIFT_METRIC,
                value: metric.lift,
              },
              childTrace(envelope.trace),
              occurredAt,
              derivedEventId(envelope.event_id, `learning.updated:${metric.modelVersion}:${LIFT_METRIC}`),
            ),
          ],
    ),
  );
}

export async function registerConsumers(deps: WorkerDeps): Promise<Subscription[]> {
  const subscription = await deps.broker.subscribe({
    consumer: 'learning-service.application-created',
    eventTypes: ['application.created'],
    handler: (envelope) => handleApplicationCreated(deps, envelope as EventEnvelope<'application.created'>),
  });
  return [subscription];
}
