import type { Database } from '@atlas/db';
import { createEvent, type EventBroker, type Subscription } from '@atlas/messaging';
import type { EventEnvelope } from '@atlas/types';
import { childTrace, type Logger } from '@atlas/utils';
import { computeLearningMetrics } from './lib/metrics.js';
import { listApplicationPairs, listRecentScores } from './repo/lookups.js';

export interface WorkerDeps {
  db: Database;
  broker: EventBroker;
  logger: Logger;
}

/**
 * A new application is itself an outcome signal, so this recomputes the
 * whole metric on every `application.created` — cheap at this data volume,
 * and simpler than adding a separate scheduled job for an MVP. Publishes one
 * `learning.updated` per model version that has enough samples to say
 * something (both an applied and a not-applied group).
 */
async function handleApplicationCreated(deps: WorkerDeps, envelope: EventEnvelope<'application.created'>) {
  const [scores, appliedPairs] = await Promise.all([listRecentScores(deps.db), listApplicationPairs(deps.db)]);
  const metrics = computeLearningMetrics(scores, appliedPairs);

  for (const metric of metrics) {
    if (metric.lift === null) continue;
    await deps.broker.publish(
      createEvent(
        'learning.updated',
        {
          model_version: metric.modelVersion,
          samples: metric.appliedSamples + metric.notAppliedSamples,
          metric: 'score_lift',
          value: metric.lift,
        },
        childTrace(envelope.trace),
      ),
    );
  }
}

export async function registerConsumers(deps: WorkerDeps): Promise<Subscription[]> {
  const subscription = await deps.broker.subscribe({
    consumer: 'learning-service.application-created',
    eventTypes: ['application.created'],
    handler: (envelope) => handleApplicationCreated(deps, envelope as EventEnvelope<'application.created'>),
  });
  return [subscription];
}
