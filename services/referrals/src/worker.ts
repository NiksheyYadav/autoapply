import type { Database } from '@atlas/db';
import { createEvent, type EventBroker, type Subscription } from '@atlas/messaging';
import type { EventEnvelope } from '@atlas/types';
import { childTrace, type Logger } from '@atlas/utils';
import { findJobById } from './repo/lookups.js';
import { topContactsForCompany } from './repo/contacts.js';

export interface WorkerDeps {
  db: Database;
  broker: EventBroker;
  logger: Logger;
}

/** How many contacts at one company are worth surfacing per application. */
const TOP_CONTACTS_PER_COMPANY = 5;

/**
 * A user just applied somewhere: check whether anyone at that company is
 * already a known contact and, if so, flag each as a referral opportunity.
 * Outreach-service (or a future one) is expected to pick up `referral.detected`
 * and draft something — this service only detects, per docs/08's split.
 */
async function handleApplicationCreated(deps: WorkerDeps, envelope: EventEnvelope<'application.created'>) {
  const { job_id, user_id } = envelope.payload;
  const job = await findJobById(deps.db, job_id);
  if (!job) return;

  const contacts = await topContactsForCompany(deps.db, job.company_id, TOP_CONTACTS_PER_COMPANY);
  for (const contact of contacts) {
    await deps.broker.publish(
      createEvent(
        'referral.detected',
        {
          contact_id: contact.contactId,
          company_id: job.company_id,
          user_id,
          relevance_score: contact.relevanceScore ?? 0,
        },
        childTrace(envelope.trace, { user_id }),
      ),
    );
  }
}

export async function registerConsumers(deps: WorkerDeps): Promise<Subscription[]> {
  const subscription = await deps.broker.subscribe({
    consumer: 'referrals-service.application-created',
    eventTypes: ['application.created'],
    handler: (envelope) => handleApplicationCreated(deps, envelope as EventEnvelope<'application.created'>),
  });
  return [subscription];
}
