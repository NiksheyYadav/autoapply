import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import type { EventBroker } from '@atlas/messaging';
import type { EventEnvelope, RawJobPosting } from '@atlas/types';
import { newTraceContext, pgErrorCode } from '@atlas/utils';
import { hashPosting, ingestPosting, type IngestPostingContext } from '../src/lib/ingest-posting.js';
import { findOrCreateByName } from '../src/repo/companies.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('ingestPosting (shared by manual ingest and source ingestion), against Postgres', () => {
  let dbHandle: DatabaseHandle;
  const tag = randomUUID().slice(0, 8);
  const companyNames: string[] = [];
  let counter = 0;

  const published: EventEnvelope[] = [];
  const broker: EventBroker = {
    publish: async (envelope) => {
      published.push(envelope);
    },
    subscribe: async (options) => ({ consumer: options.consumer, stop: async () => undefined }),
    isHealthy: () => true,
    close: async () => undefined,
  };

  beforeAll(() => {
    dbHandle = createDatabase({ url: testDatabaseUrl!, maxConnections: 10 });
  });

  afterAll(async () => {
    for (const name of companyNames) {
      await dbHandle.db.delete(schema.companies).where(eq(schema.companies.name, name));
    }
    await dbHandle.close();
  });

  function posting(overrides: Partial<RawJobPosting> = {}): RawJobPosting {
    counter += 1;
    const companyName = overrides.company_name ?? `Posting Co ${tag} ${counter}`;
    if (!companyNames.includes(companyName)) companyNames.push(companyName);
    return {
      source: 'lever',
      external_id: `p-${tag}-${counter}`,
      title: `Platform Engineer ${tag} ${counter}`,
      company_name: companyName,
      description: 'Build services in TypeScript and PostgreSQL for a growing catalog of roles.',
      location: 'Berlin',
      remote_type: 'remote',
      employment_type: 'Full-time',
      apply_url: 'https://jobs.example.com/apply',
      posted_at: '2026-10-01T00:00:00Z',
      ...overrides,
    };
  }

  const context = (overrides: Partial<IngestPostingContext> = {}): IngestPostingContext => ({
    db: dbHandle.db,
    broker,
    newTrace: () => newTraceContext(),
    ...overrides,
  });

  const rowsFor = async (companyName: string) =>
    dbHandle.db
      .select({ job: schema.jobs })
      .from(schema.jobs)
      .innerJoin(schema.companies, eq(schema.jobs.companyId, schema.companies.companyId))
      .where(eq(schema.companies.name, companyName))
      .then((rows) => rows.map((row) => row.job));

  it('inserts a new posting and announces it with the job, company, source, hash and title', async () => {
    const input = posting();
    const before = published.length;

    const outcome = await ingestPosting(context(), input);

    expect(outcome.kind).toBe('inserted');
    const [job] = await rowsFor(input.company_name);
    expect(job).toMatchObject({
      jobId: outcome.jobId,
      title: input.title,
      source: 'lever',
      externalId: input.external_id,
      remoteType: 'remote',
      employmentType: 'full_time',
      isActive: true,
      jobHash: hashPosting(input),
    });
    expect(job?.skills.length).toBeGreaterThan(0);

    const events = published.slice(before);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('job.discovered');
    expect(events[0]?.payload).toEqual({
      job_id: job?.jobId,
      company_id: job?.companyId,
      source: 'lever',
      job_hash: job?.jobHash,
      title: input.title,
    });
  });

  it('stamps every event with a trace of its own', async () => {
    const before = published.length;
    await ingestPosting(context(), posting());
    await ingestPosting(context(), posting());
    const [first, second] = published.slice(before);
    expect(first?.trace.trace_id).toBeTruthy();
    expect(first?.trace.trace_id).not.toBe(second?.trace.trace_id);
  });

  it('reports a posting that is already stored as a duplicate, refreshes it, and publishes nothing', async () => {
    const input = posting();
    const first = await ingestPosting(context(), input);
    const [stored] = await rowsFor(input.company_name);
    await dbHandle.db.update(schema.jobs).set({ isActive: false }).where(eq(schema.jobs.jobId, first.jobId));
    const before = published.length;

    const second = await ingestPosting(context(), input);

    expect(second).toEqual({ kind: 'duplicate', jobId: first.jobId });
    expect(published.length).toBe(before);
    const [after] = await rowsFor(input.company_name);
    expect(after?.isActive).toBe(true);
    expect(Date.parse(after!.lastSeenAt)).toBeGreaterThan(Date.parse(stored!.lastSeenAt));
  });

  it('settles a burst of identical postings to one insert and duplicates, never an error', async () => {
    const input = posting();
    // With the company already resolved, all eight calls reach the job insert together, so the
    // losers hit the unique violation rather than finding the winner's row beforehand.
    const company = await findOrCreateByName(dbHandle.db, input.company_name, null);
    const before = published.length;

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => ingestPosting(context({ company }), input)));

    expect(outcomes.filter((outcome) => outcome.kind === 'inserted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'duplicate')).toHaveLength(7);
    expect(new Set(outcomes.map((outcome) => outcome.jobId)).size).toBe(1);
    expect(await rowsFor(input.company_name)).toHaveLength(1);
    expect(published.length - before).toBe(1);
  });

  it('settles a burst that also has to create the company', async () => {
    const input = posting();

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => ingestPosting(context(), input)));

    expect(outcomes.filter((outcome) => outcome.kind === 'inserted')).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.jobId)).size).toBe(1);
    expect(await rowsFor(input.company_name)).toHaveLength(1);
  });

  it('uses the company the caller resolved, without creating or looking up another', async () => {
    const resolvedName = `Resolved Co ${tag}`;
    const otherName = `Named In Posting Co ${tag}`;
    companyNames.push(resolvedName, otherName);
    const company = await findOrCreateByName(dbHandle.db, resolvedName, null);
    // The posting names a different company; the caller's resolution wins.
    const input = posting({ company_name: otherName });

    const outcome = await ingestPosting(context({ company }), input);

    const [job] = await rowsFor(resolvedName);
    expect(job?.jobId).toBe(outcome.jobId);
    expect(job?.companyId).toBe(company.companyId);
    expect(await dbHandle.db.select().from(schema.companies).where(eq(schema.companies.name, otherName))).toHaveLength(0);
  });

  describe('a listing its source has edited (same external id, new content)', () => {
    it('is left as a failure unless the caller opts in, which is what the manual endpoint does', async () => {
      const original = posting();
      await ingestPosting(context(), original);
      const edited = { ...original, title: `${original.title} (edited)` };

      const error = await ingestPosting(context(), edited).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(pgErrorCode(error)).toBe('23505');
      const rows = await rowsFor(original.company_name);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe(original.title);
    });

    it('is rewritten in place when the caller opts in, keeping its identity, and announced again', async () => {
      const original = posting();
      const first = await ingestPosting(context(), original);
      const [stored] = await rowsFor(original.company_name);
      const before = published.length;
      const edited = { ...original, title: `${original.title} (edited)`, location: 'Lisbon', description: 'Now with Kubernetes and Go.' };

      const outcome = await ingestPosting(context({ updateChangedListings: true }), edited);

      expect(outcome).toEqual({ kind: 'updated', jobId: first.jobId });
      const rows = await rowsFor(original.company_name);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        jobId: first.jobId,
        title: edited.title,
        location: 'Lisbon',
        description: 'Now with Kubernetes and Go.',
        jobHash: hashPosting(edited),
        isActive: true,
        createdAt: stored?.createdAt,
      });
      expect(rows[0]?.skills).toContain('kubernetes');
      expect(published.slice(before).map((event) => event.event_type)).toEqual(['job.discovered']);
    });

    it('revives a listing that had been deactivated', async () => {
      const original = posting();
      const first = await ingestPosting(context(), original);
      await dbHandle.db.update(schema.jobs).set({ isActive: false }).where(eq(schema.jobs.jobId, first.jobId));

      await ingestPosting(context({ updateChangedListings: true }), { ...original, title: `${original.title} v2` });

      expect((await rowsFor(original.company_name))[0]?.isActive).toBe(true);
    });

    it('does not touch a posting without an external id, which can only be matched by content', async () => {
      const input = posting({ external_id: null });
      const first = await ingestPosting(context({ updateChangedListings: true }), input);
      const second = await ingestPosting(context({ updateChangedListings: true }), { ...input, title: `${input.title} v2` });

      expect(first.kind).toBe('inserted');
      expect(second.kind).toBe('inserted');
      expect(await rowsFor(input.company_name)).toHaveLength(2);
    });
  });
});
