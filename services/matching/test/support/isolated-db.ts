/**
 * Test harness for the at-least-once suites of the four event consumers
 * (matching, referrals, learning, analytics).
 *
 * The suites publish through a real `PostgresBroker` and drain it, and a
 * fan-out seeds hundreds of jobs and candidates. Done in the shared tables,
 * that would hand those jobs to every other test's `resume.parsed` handler
 * (which scores the 500 newest active jobs) and let this test's consumers pick
 * up other tests' outbox rows under the real consumer names. So each suite
 * gets a private schema holding copies of exactly the tables it touches, and a
 * pool whose `search_path` points at it; unqualified table names in the
 * services' queries and in the broker's raw SQL then resolve to the copies.
 * `LIKE ... INCLUDING ALL` copies columns, defaults, keys and indexes but not
 * foreign keys, so no `auth.users`/`companies` rows are needed either.
 *
 * Kept under matching's tests and imported by the other three: it is test
 * code, and the only thing the suites share.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createDatabase, schema, type Database, type DatabaseHandle } from '@atlas/db';
import {
  PostgresBroker,
  type BatchPublisher,
  type EventHandler,
  type PostgresBrokerOptions,
} from '@atlas/messaging';
import type { EventEnvelope, ParsedProfile } from '@atlas/types';
import { createSilentLogger } from '@atlas/utils';

const COPIED_TABLES = [
  'event_outbox',
  'event_consumers',
  'event_deliveries',
  'processed_events',
  'jobs',
  'resumes',
  'job_scores',
  'applications',
  'contacts',
  'analytics_events',
] as const;

export interface IsolatedDatabase {
  schemaName: string;
  /** Pool on the private schema (raw `sql` for assertions and cleanup). */
  handle: DatabaseHandle;
  /** Drizzle over that same pool; every statement it sends is appended to `queries`. */
  db: Database;
  queries: string[];
  /** Empties every copied table and the statement log. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createIsolatedDatabase(
  url: string,
  options: { maxConnections?: number } = {},
): Promise<IsolatedDatabase> {
  const schemaName = `atlas_consumer_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  // The setup and teardown connection is closed in between: several suites run
  // in parallel against one server with a fixed connection limit.
  const withAdmin = async <T>(run: (admin: DatabaseHandle) => Promise<T>): Promise<T> => {
    const admin = createDatabase({ url, maxConnections: 1 });
    try {
      return await run(admin);
    } finally {
      await admin.close();
    }
  };

  await withAdmin(async (admin) => {
    await admin.sql.unsafe(`CREATE SCHEMA ${schemaName}`);
    for (const table of COPIED_TABLES) {
      await admin.sql.unsafe(
        `CREATE TABLE ${schemaName}.${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    }
    await admin.sql.unsafe(
      `ALTER TABLE ${schemaName}.event_deliveries ADD FOREIGN KEY (event_id) REFERENCES ${schemaName}.event_outbox (event_id) ON DELETE CASCADE`,
    );
  });

  const scoped = new URL(url);
  scoped.searchParams.set('search_path', `${schemaName},public`);
  const handle = createDatabase({
    url: scoped.toString(),
    maxConnections: options.maxConnections ?? 6,
  });
  const queries: string[] = [];
  const db = drizzle(handle.sql, {
    schema,
    logger: { logQuery: (query) => void queries.push(query) },
  });

  return {
    schemaName,
    handle,
    db,
    queries,
    reset: async () => {
      await handle.sql.unsafe(
        `TRUNCATE ${COPIED_TABLES.map((table) => `${schemaName}.${table}`).join(', ')}`,
      );
      queries.length = 0;
    },
    close: async () => {
      await handle.close();
      await withAdmin((admin) => admin.sql.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`));
    },
  };
}

const silent = createSilentLogger();

/** A `PostgresBroker` on the private schema with no retry backoff, so a failed delivery is due again at once. */
export function newPostgresBroker(
  isolated: IsolatedDatabase,
  overrides: Partial<PostgresBrokerOptions> = {},
): PostgresBroker {
  return new PostgresBroker({ db: isolated.db, logger: silent, backoffMs: () => 0, ...overrides });
}

export interface SpyBroker extends BatchPublisher {
  /** The real broker underneath, for `drain`, `purge` and direct publishes. */
  readonly inner: PostgresBroker;
  /** The handler each consumer registered, to call directly with an envelope. */
  handlers: Map<string, EventHandler>;
  /**
   * Publishes still allowed before every further publish fails. A `publishMany`
   * that runs out part-way commits the part that fits first, as a real
   * connection loss between two statements would. `Infinity` is healthy.
   */
  publishBudget: number;
  /** Handlers run through this gate (default: straight through). */
  beforeHandle: () => Promise<void>;
}

/**
 * Wraps a broker so a suite can call a consumer's handler directly with a
 * chosen envelope, make publishing fail after N events, or hold handlers at a
 * barrier. `subscribe` still forwards, so the same wrapper can also be drained.
 */
export function spyBroker(inner: PostgresBroker): SpyBroker {
  const spy: SpyBroker = {
    inner,
    handlers: new Map(),
    publishBudget: Number.POSITIVE_INFINITY,
    beforeHandle: async () => undefined,
    async publish(envelope) {
      if (spy.publishBudget < 1) throw new Error('injected publish failure');
      spy.publishBudget -= 1;
      await inner.publish(envelope);
    },
    async publishMany(envelopes) {
      const allowed = Math.max(0, Math.min(envelopes.length, spy.publishBudget));
      spy.publishBudget -= allowed;
      if (allowed > 0) await inner.publishMany(envelopes.slice(0, allowed));
      if (allowed < envelopes.length) throw new Error('injected publish failure');
    },
    async subscribe(options) {
      spy.handlers.set(options.consumer, options.handler);
      return inner.subscribe({
        ...options,
        handler: async (envelope, context) => {
          await spy.beforeHandle();
          await options.handler(envelope, context);
        },
      });
    },
    isHealthy: () => inner.isHealthy(),
    close: () => inner.close(),
  };
  return spy;
}

/** Runs a consumer's handler directly, the way a drain would after claiming the delivery. */
export function deliver(
  spy: SpyBroker,
  consumer: string,
  envelope: EventEnvelope,
  attempt = 0,
): Promise<void> {
  const handler = spy.handlers.get(consumer);
  if (!handler) throw new Error(`no handler registered for ${consumer}`);
  return handler(envelope, { attempt, trace: envelope.trace });
}

export function parsedProfile(skills: string[], totalMonths: number): ParsedProfile {
  return {
    full_name: 'Test Candidate',
    headline: null,
    summary: null,
    contact: { email: null, phone: null, location: null, links: [] },
    skills: skills.map((name) => ({ name, raw: name, months_experience: totalMonths })),
    experience: [],
    education: [],
    certifications: [],
    keywords: [],
    total_months_experience: totalMonths,
  };
}

export const SKILL_POOL = [
  'typescript',
  'postgresql',
  'react',
  'node',
  'python',
  'go',
  'rust',
  'kafka',
];

/** `count` active jobs with varied titles and skills, newest first by index. */
export async function seedJobs(
  isolated: IsolatedDatabase,
  count: number,
  companyId = randomUUID(),
): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, index) => ({
    companyId,
    title: ['Senior Engineer', 'Junior Engineer', 'Engineer'][index % 3] as string,
    source: 'manual' as const,
    jobHash: `${randomUUID().replace(/-/g, '')}${index}`.padEnd(64, '0').slice(0, 64),
    skills: SKILL_POOL.filter((_skill, skillIndex) => (index + skillIndex) % 3 !== 0),
    isActive: true,
  }));
  const inserted: { jobId: string }[] = [];
  for (let start = 0; start < rows.length; start += 250) {
    inserted.push(
      ...(await isolated.db
        .insert(schema.jobs)
        .values(rows.slice(start, start + 250))
        .returning({ jobId: schema.jobs.jobId })),
    );
  }
  return inserted.map((row) => row.jobId);
}

/** One parsed resume per user, with skills varying by position so scores differ. */
export async function seedParsedResumes(
  isolated: IsolatedDatabase,
  userIds: string[],
): Promise<void> {
  const rows = userIds.map((userId, index) => ({
    userId,
    storageUrl: `resumes/${userId}/seed`,
    originalFilename: 'resume.txt',
    contentType: 'text/plain',
    byteSize: 10,
    contentHash: randomUUID(),
    status: 'parsed' as const,
    parsedProfile: parsedProfile(
      SKILL_POOL.filter((_skill, skillIndex) => (index + skillIndex) % 2 === 0),
      6 + (index % 60),
    ),
    parsedAt: new Date(Date.now() - index * 1000).toISOString(),
  }));
  for (let start = 0; start < rows.length; start += 250) {
    await isolated.db.insert(schema.resumes).values(rows.slice(start, start + 250));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Holds every caller of `arrive` until `parties` have arrived (or `timeoutMs` passes, so a missed rendezvous fails a test instead of hanging it). */
export function createBarrier(parties: number, timeoutMs = 5_000) {
  let arrivals = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    get arrivals(): number {
      return arrivals;
    },
    async arrive(): Promise<void> {
      arrivals += 1;
      if (arrivals >= parties) open();
      await Promise.race([opened, sleep(timeoutMs)]);
    },
  };
}

export interface RaceResult {
  /** How many handler invocations reached the rendezvous; 2 means the race really happened. */
  handlerRuns: number;
}

/**
 * Makes two drains deliver the same event to the same consumer at the same
 * time: the situation a lease that expired mid-handler produces in production,
 * where "the broker leases deliveries" no longer protects the handler. The
 * first drain claims the delivery and is held inside its handler; once its
 * (very short) lease has lapsed a second drain claims the same delivery, and
 * both handlers are released together.
 *
 * `register` subscribes the consumers under test on each of the two brokers;
 * the event must already be in the outbox.
 */
export async function raceTwoDrains(
  isolated: IsolatedDatabase,
  register: (broker: SpyBroker) => Promise<unknown>,
): Promise<RaceResult> {
  const leaseMs = 25;
  const barrier = createBarrier(2);
  const [first, second] = [1, 2].map(() => {
    const broker = spyBroker(newPostgresBroker(isolated, { leaseMs, retentionMs: 0 }));
    broker.beforeHandle = () => barrier.arrive();
    return broker;
  }) as [SpyBroker, SpyBroker];
  await register(first);
  await register(second);

  const firstDrain = first.inner.drain({ budgetMs: 15_000 });
  while (barrier.arrivals < 1) await sleep(5);
  await sleep(leaseMs + 50);
  const secondDrain = second.inner.drain({ budgetMs: 15_000 });
  await Promise.all([firstDrain, secondDrain]);
  return { handlerRuns: barrier.arrivals };
}
