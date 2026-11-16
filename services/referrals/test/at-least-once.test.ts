/**
 * referrals-service under at-least-once delivery: `application.created` can
 * reach the handler again (a retry after a failure part-way, an expired lease,
 * two drains racing), and one referral must stay one `referral.detected` — it
 * is what outreach acts on.
 *
 * Runs against a private schema (see matching's support/isolated-db.ts).
 * DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@atlas/db';
import { createEvent, derivedEventId } from '@atlas/messaging';
import type { EventEnvelope } from '@atlas/types';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import {
  createIsolatedDatabase,
  deliver,
  newPostgresBroker,
  spyBroker,
  type IsolatedDatabase,
  type SpyBroker,
} from '../../matching/test/support/isolated-db.js';
import { registerConsumers } from '../src/worker.js';

const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const CONSUMER = 'referrals-service.application-created';

describe.skipIf(!testDatabaseUrl)('referrals-service under at-least-once delivery', () => {
  let isolated: IsolatedDatabase;
  let spy: SpyBroker;
  const sql = () => isolated.handle.sql;

  beforeAll(async () => {
    isolated = await createIsolatedDatabase(testDatabaseUrl as string);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(async () => {
    await isolated.reset();
    spy = spyBroker(newPostgresBroker(isolated));
    await registerConsumers({ db: isolated.db, broker: spy, logger: createSilentLogger() });
  });

  /** A company with `contactCount` contacts (relevance falling from 0.95), a job there, and an application to it. */
  async function seedApplication(contactCount: number) {
    const companyId = randomUUID();
    const userId = randomUUID();
    const [job] = await isolated.db
      .insert(schema.jobs)
      .values({
        companyId,
        title: 'Backend Engineer',
        source: 'manual',
        jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      })
      .returning();
    const [application] = await isolated.db
      .insert(schema.applications)
      .values({
        userId,
        jobId: job?.jobId as string,
        mode: 'manual',
        status: 'draft',
        idempotencyKey: randomUUID(),
      })
      .returning();
    const contacts =
      contactCount === 0
        ? []
        : await isolated.db
            .insert(schema.contacts)
            .values(
              Array.from({ length: contactCount }, (_, index) => ({
                companyId,
                email: `contact-${index}-${randomUUID()}@example.com`,
                relevanceScore: 0.95 - index * 0.1,
              })),
            )
            .returning();
    return {
      companyId,
      userId,
      jobId: job?.jobId as string,
      applicationId: application?.applicationId as string,
      /** Contacts the handler should pick: the five most relevant. */
      topContactIds: contacts
        .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
        .slice(0, 5)
        .map((contact) => contact.contactId),
    };
  }

  function applicationCreated(seed: {
    applicationId: string;
    userId: string;
    jobId: string;
  }): EventEnvelope<'application.created'> {
    return createEvent(
      'application.created',
      {
        application_id: seed.applicationId,
        user_id: seed.userId,
        job_id: seed.jobId,
        mode: 'manual',
      },
      newTraceContext({ user_id: seed.userId }),
    );
  }

  async function detected() {
    return sql()<
      {
        event_id: string;
        payload: {
          contact_id: string;
          company_id: string;
          user_id: string;
          relevance_score: number;
        };
      }[]
    >`
      select event_id, payload from event_outbox where event_type = 'referral.detected' order by event_id`;
  }

  async function duplicatedDetections() {
    return sql()<{ contact_id: string; copies: number }[]>`
      select payload->>'contact_id' as contact_id, count(*)::int as copies
      from event_outbox where event_type = 'referral.detected'
      group by 1 having count(*) > 1`;
  }

  it('publishes one referral.detected per top contact, keyed by the event, the contact and the application', async () => {
    const seed = await seedApplication(7);
    const envelope = applicationCreated(seed);

    await deliver(spy, CONSUMER, envelope);

    const events = await detected();
    expect(events.map((event) => event.event_id).sort()).toEqual(
      seed.topContactIds
        .map((contactId) =>
          derivedEventId(envelope.event_id, `referral.detected:${contactId}:${seed.applicationId}`),
        )
        .sort(),
    );
    expect(
      events.every(
        (event) =>
          event.payload.company_id === seed.companyId && event.payload.user_id === seed.userId,
      ),
    ).toBe(true);
    expect(events.map((event) => event.payload.contact_id).sort()).toEqual(
      [...seed.topContactIds].sort(),
    );
  });

  it('a redelivered event publishes nothing new', async () => {
    const seed = await seedApplication(5);
    const envelope = applicationCreated(seed);

    await deliver(spy, CONSUMER, envelope);
    const before = await detected();
    await deliver(spy, CONSUMER, envelope, 1);
    await deliver(spy, CONSUMER, envelope, 2);

    expect(await detected()).toEqual(before);
    expect(before).toHaveLength(5);
  });

  it('the same event delivered to several handlers at once publishes each detection once', async () => {
    const seed = await seedApplication(5);
    const envelope = applicationCreated(seed);

    await Promise.all([1, 2, 3, 4].map((attempt) => deliver(spy, CONSUMER, envelope, attempt)));

    expect(await detected()).toHaveLength(5);
    expect(await duplicatedDetections()).toEqual([]);
  });

  it('a failure part-way and its retry publish each detection exactly once', async () => {
    const seed = await seedApplication(5);
    const envelope = applicationCreated(seed);

    spy.publishBudget = 2;
    await expect(deliver(spy, CONSUMER, envelope)).rejects.toThrow('injected publish failure');
    spy.publishBudget = Number.POSITIVE_INFINITY;
    await deliver(spy, CONSUMER, envelope, 1);

    expect(await detected()).toHaveLength(5);
    expect(await duplicatedDetections()).toEqual([]);
  });

  it('a different application at the same company is a different detection', async () => {
    const first = await seedApplication(3);
    const [secondApplication] = await isolated.db
      .insert(schema.applications)
      .values({
        userId: randomUUID(),
        jobId: first.jobId,
        mode: 'manual',
        status: 'draft',
        idempotencyKey: randomUUID(),
      })
      .returning();
    const second = {
      ...first,
      applicationId: secondApplication?.applicationId as string,
      userId: secondApplication?.userId as string,
    };

    await deliver(spy, CONSUMER, applicationCreated(first));
    await deliver(spy, CONSUMER, applicationCreated(second));

    expect(await detected()).toHaveLength(6);
  });

  it('publishes nothing for a missing job or a company with no contacts', async () => {
    const lonely = await seedApplication(0);

    await deliver(spy, CONSUMER, applicationCreated(lonely));
    await deliver(spy, CONSUMER, applicationCreated({ ...lonely, jobId: randomUUID() }));

    expect(await detected()).toHaveLength(0);
  });
});
