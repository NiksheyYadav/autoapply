import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import type { EventBroker } from '@atlas/messaging';
import type { EventEnvelope, IngestSourcesReport, JobBoardProvider } from '@atlas/types';
import { createSilentLogger } from '@atlas/utils';
import {
  decideDeactivation,
  MIN_WINDOW_TO_START_SOURCE_MS,
  runSourceIngestion,
  SHARP_DROP_MIN_PREVIOUS,
  type RunSourcesOptions,
} from '../src/lib/run-sources.js';
import { upsert } from '../src/repo/job-sources.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

describe('decideDeactivation', () => {
  const healthy = { listed: 40, previousListed: 42, rejected: 0, complete: true };

  it('allows deactivation after a complete, ordinary run', () => {
    expect(decideDeactivation(healthy)).toEqual({ apply: true });
    expect(decideDeactivation({ ...healthy, previousListed: null })).toEqual({ apply: true });
  });

  it('refuses an empty result, whatever came before', () => {
    expect(decideDeactivation({ ...healthy, listed: 0 })).toEqual({ apply: false, reason: 'empty_result' });
    expect(decideDeactivation({ ...healthy, listed: 0, previousListed: null })).toEqual({ apply: false, reason: 'empty_result' });
  });

  it('refuses a run that did not process every posting', () => {
    expect(decideDeactivation({ ...healthy, complete: false })).toEqual({ apply: false, reason: 'incomplete_run' });
  });

  it('refuses when any posting could not be stored', () => {
    expect(decideDeactivation({ ...healthy, rejected: 1 })).toEqual({ apply: false, reason: 'rejected_postings' });
  });

  it('holds back a sharp drop from a sizeable board, but not a small board or an ordinary decline', () => {
    expect(decideDeactivation({ listed: 1, previousListed: 12, rejected: 0, complete: true })).toEqual({
      apply: false,
      reason: 'sharp_drop',
    });
    // Exactly 20% of the previous count is not "below" it.
    expect(decideDeactivation({ listed: 20, previousListed: 100, rejected: 0, complete: true })).toEqual({ apply: true });
    expect(decideDeactivation({ listed: 19, previousListed: 100, rejected: 0, complete: true })).toEqual({
      apply: false,
      reason: 'sharp_drop',
    });
    // A small board can shrink to nothing-ish without tripping the ratio guard.
    expect(decideDeactivation({ listed: 1, previousListed: SHARP_DROP_MIN_PREVIOUS - 1, rejected: 0, complete: true })).toEqual({
      apply: true,
    });
  });
});

describe.skipIf(!testDatabaseUrl)('scheduled job source ingestion, against Postgres', () => {
  let dbHandle: DatabaseHandle;
  const tag = randomUUID().slice(0, 8);
  const sourceIds: string[] = [];
  const companyNames: string[] = [];
  let counter = 0;

  // A broker that remembers what was published, and can be told to fail or to run code per publish.
  const published: EventEnvelope[] = [];
  let beforePublish: (envelope: EventEnvelope) => void | Promise<void> = () => undefined;
  const broker: EventBroker = {
    publish: async (envelope) => {
      await beforePublish(envelope);
      published.push(envelope);
    },
    subscribe: async (options) => ({ consumer: options.consumer, stop: async () => undefined }),
    isHealthy: () => true,
    close: async () => undefined,
  };

  beforeAll(() => {
    dbHandle = createDatabase({ url: testDatabaseUrl!, maxConnections: 8 });
  });

  afterAll(async () => {
    if (companyNames.length > 0) {
      await dbHandle.db.delete(schema.companies).where(inArray(schema.companies.name, companyNames));
    }
    if (sourceIds.length > 0) {
      await dbHandle.db.delete(schema.jobSources).where(inArray(schema.jobSources.sourceId, sourceIds));
    }
    await dbHandle.close();
  });

  /** A fresh source for a company that exists nowhere else. */
  async function makeSource(
    provider: JobBoardProvider,
    options: { companyName?: string; enabled?: boolean } = {},
  ) {
    counter += 1;
    const companyName = options.companyName ?? `Ingest Co ${tag} ${counter}`;
    companyNames.push(companyName);
    const { row } = await upsert(dbHandle.db, {
      provider,
      boardToken: `ing-${tag}-${counter}`,
      companyName,
      enabled: options.enabled,
    });
    sourceIds.push(row.sourceId);
    return row;
  }

  type Responder = (url: URL) => Response | Promise<Response>;

  /** A `fetch` that answers per URL from `responders` (404 for anything else) and records every call. */
  function routedFetch(responders: Record<string, Responder>) {
    const calls: string[] = [];
    const impl: typeof fetch = async (input) => {
      const url = input as URL;
      calls.push(url.href);
      const responder = responders[url.href];
      return responder ? responder(url) : new Response('not found', { status: 404 });
    };
    return { impl, calls };
  }

  const urlFor = (provider: JobBoardProvider, token: string): string =>
    ({
      greenhouse: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
      lever: `https://api.lever.co/v0/postings/${token}?mode=json`,
      ashby: `https://api.ashbyhq.com/posting-api/job-board/${token}`,
    })[provider];

  const jsonResponse = (body: unknown): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  function run(
    fetchImpl: typeof fetch,
    ids: readonly string[],
    overrides: Partial<RunSourcesOptions> = {},
  ): Promise<IngestSourcesReport> {
    return runSourceIngestion(
      { db: dbHandle.db, broker, logger: createSilentLogger(), fetch: fetchImpl, userAgent: 'AtlasJobIngest/test' },
      { budgetMs: 20_000, sourceIds: ids, ...overrides },
    );
  }

  async function jobsOf(companyName: string) {
    return dbHandle.db
      .select({ job: schema.jobs })
      .from(schema.jobs)
      .innerJoin(schema.companies, eq(schema.jobs.companyId, schema.companies.companyId))
      .where(eq(schema.companies.name, companyName))
      .then((rows) => rows.map((row) => row.job));
  }

  async function sourceRow(sourceId: string) {
    const [row] = await dbHandle.db.select().from(schema.jobSources).where(eq(schema.jobSources.sourceId, sourceId));
    return row!;
  }

  /** `n` distinct Lever postings for one source; titles are unique per call so hashes never collide across tests. */
  function leverPostings(label: string, n: number, titleSuffix = ''): Array<Record<string, unknown>> {
    return Array.from({ length: n }, (_unused, index) => ({
      id: `${label}-${index}`,
      text: `Engineer ${label} ${index}${titleSuffix}`,
      categories: { location: 'Berlin', commitment: 'Full-time', allLocations: ['Berlin'] },
      workplaceType: 'remote',
      descriptionPlain: `Build and run services in TypeScript and PostgreSQL. Opening ${index}.`,
      hostedUrl: `https://jobs.lever.co/x/${label}-${index}`,
      applyUrl: `https://jobs.lever.co/x/${label}-${index}/apply`,
      createdAt: 1_788_199_939_703,
    }));
  }

  describe('first run and re-runs', () => {
    it('stores the postings a board lists, and publishes job.discovered for each', async () => {
      const source = await makeSource('greenhouse', { companyName: `Figma Test ${tag}` });
      const { impl } = routedFetch({
        [urlFor('greenhouse', source.boardToken)]: () => jsonResponse(fixtureText('greenhouse-jobs-content.json')),
      });
      const before = published.length;

      const report = await run(impl, [source.sourceId]);

      expect(report).toMatchObject({
        sources_total: 1,
        attempted: 1,
        succeeded: 1,
        failed: 0,
        not_attempted: 0,
        inserted: 2,
        updated: 0,
        duplicates: 0,
        rejected: 0,
        deactivated: 0,
      });
      expect(report.sources[0]).toMatchObject({
        source_id: source.sourceId,
        provider: 'greenhouse',
        status: 'ok',
        fetched: 2,
        skipped: 0,
        deactivation_skipped: null,
        error: null,
      });

      const jobs = await jobsOf(source.companyName);
      expect(jobs).toHaveLength(2);
      const intern = jobs.find((job) => job.externalId === '6143238004')!;
      expect(intern).toMatchObject({
        source: 'greenhouse',
        title: 'Software Engineer Intern (Summer 2027)',
        employmentType: 'internship',
        isActive: true,
        applyUrl: 'https://boards.greenhouse.io/figma/jobs/6143238004?gh_jid=6143238004',
      });
      expect(intern.description).toContain('Figma is growing our team');
      expect(intern.description).not.toMatch(/&lt;|<p>/);

      const events = published.slice(before);
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.event_type)).toEqual(['job.discovered', 'job.discovered']);
      expect(new Set(events.map((event) => (event.payload as { job_id: string }).job_id))).toEqual(new Set(jobs.map((job) => job.jobId)));

      const stored = await sourceRow(source.sourceId);
      expect(stored).toMatchObject({ lastStatus: 'ok', lastError: null, lastJobCount: 2 });
      expect(stored.lastFetchedAt).not.toBeNull();
    });

    it('inserts nothing the second time, and publishes nothing', async () => {
      const source = await makeSource('lever');
      const postings = leverPostings(`idem-${tag}`, 5);
      const { impl } = routedFetch({ [urlFor('lever', source.boardToken)]: () => jsonResponse(postings) });

      const first = await run(impl, [source.sourceId]);
      expect(first).toMatchObject({ inserted: 5, duplicates: 0 });
      const rowsAfterFirst = await jobsOf(source.companyName);
      const eventsAfterFirst = published.length;

      const second = await run(impl, [source.sourceId]);
      expect(second).toMatchObject({ inserted: 0, updated: 0, duplicates: 5, rejected: 0, deactivated: 0 });
      expect(second.sources[0]).toMatchObject({ status: 'ok', fetched: 5 });

      const rowsAfterSecond = await jobsOf(source.companyName);
      expect(rowsAfterSecond).toHaveLength(5);
      expect(rowsAfterSecond.map((job) => job.jobId).sort()).toEqual(rowsAfterFirst.map((job) => job.jobId).sort());
      expect(published.length).toBe(eventsAfterFirst);

      // Seen again means fresh again.
      const firstSeen = new Map(rowsAfterFirst.map((job) => [job.jobId, Date.parse(job.lastSeenAt)]));
      for (const job of rowsAfterSecond) expect(Date.parse(job.lastSeenAt)).toBeGreaterThan(firstSeen.get(job.jobId)!);
    });

    it('counts postings that share a content hash once, however often the board repeats them', async () => {
      const source = await makeSource('lever');
      const twin = leverPostings(`twin-${tag}`, 1)[0]!;
      const { impl } = routedFetch({
        // Same company, title, location and workplace type under two ids: one listing for matching purposes.
        [urlFor('lever', source.boardToken)]: () => jsonResponse([twin, { ...twin, id: `${String(twin.id)}-repost` }]),
      });

      const report = await run(impl, [source.sourceId]);
      expect(report).toMatchObject({ inserted: 1, duplicates: 1, rejected: 0 });
      expect(await jobsOf(source.companyName)).toHaveLength(1);
    });

    it('rewrites a listing in place when the board edits it, instead of rejecting the edit', async () => {
      const source = await makeSource('lever');
      const original = leverPostings(`edit-${tag}`, 3);
      let current: Array<Record<string, unknown>> = original;
      const { impl } = routedFetch({ [urlFor('lever', source.boardToken)]: () => jsonResponse(current) });

      await run(impl, [source.sourceId]);
      const before = await jobsOf(source.companyName);
      const target = before.find((job) => job.externalId === `edit-${tag}-1`)!;
      const eventsBefore = published.length;

      // Same posting id, new title and location: a new content hash.
      current = original.map((posting) =>
        posting.id === `edit-${tag}-1`
          ? { ...posting, text: `Staff Engineer ${tag} (renamed)`, categories: { location: 'Lisbon', commitment: 'Full-time', allLocations: ['Lisbon'] } }
          : posting,
      );
      const report = await run(impl, [source.sourceId]);

      expect(report).toMatchObject({ inserted: 0, updated: 1, duplicates: 2, rejected: 0, deactivated: 0 });
      const after = await jobsOf(source.companyName);
      expect(after).toHaveLength(3);
      const rewritten = after.find((job) => job.externalId === `edit-${tag}-1`)!;
      expect(rewritten.jobId).toBe(target.jobId);
      expect(rewritten).toMatchObject({ title: `Staff Engineer ${tag} (renamed)`, location: 'Lisbon', isActive: true });
      expect(rewritten.jobHash).not.toBe(target.jobHash);
      expect(rewritten.createdAt).toBe(target.createdAt);

      // It is re-announced so matching scores the new content.
      const events = published.slice(eventsBefore);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ job_id: target.jobId, title: `Staff Engineer ${tag} (renamed)` });
    });
  });

  describe('deactivating postings a source no longer lists', () => {
    it('marks vanished postings inactive, leaves the rest, and revives one that comes back', async () => {
      const source = await makeSource('lever');
      const all = leverPostings(`vanish-${tag}`, 4);
      let listed = all;
      const { impl } = routedFetch({ [urlFor('lever', source.boardToken)]: () => jsonResponse(listed) });

      await run(impl, [source.sourceId]);
      expect((await jobsOf(source.companyName)).every((job) => job.isActive)).toBe(true);

      listed = all.slice(0, 3);
      const second = await run(impl, [source.sourceId]);
      expect(second).toMatchObject({ inserted: 0, duplicates: 3, deactivated: 1 });
      expect(second.sources[0]?.deactivation_skipped).toBeNull();
      const afterSecond = await jobsOf(source.companyName);
      expect(afterSecond.filter((job) => !job.isActive).map((job) => job.externalId)).toEqual([`vanish-${tag}-3`]);
      expect(afterSecond.filter((job) => job.isActive)).toHaveLength(3);

      listed = all;
      const third = await run(impl, [source.sourceId]);
      expect(third).toMatchObject({ inserted: 0, duplicates: 4, deactivated: 0 });
      expect((await jobsOf(source.companyName)).every((job) => job.isActive)).toBe(true);
    });

    it('only retires what that source itself brought in: not manual postings, not another provider\'s', async () => {
      const companyName = `Shared Co ${tag}`;
      const lever = await makeSource('lever', { companyName });
      const ashby = await makeSource('ashby', { companyName });
      const leverPosts = leverPostings(`scope-l-${tag}`, 3);
      let leverListed = leverPosts;
      const ashbyPosts = {
        jobs: [{ id: `scope-a-${tag}`, title: `Ashby only ${tag}`, location: 'Paris', workplaceType: 'Remote', employmentType: 'FullTime', descriptionPlain: 'Ashby posting', applyUrl: 'https://jobs.ashbyhq.com/x/1' }],
      };
      const { impl } = routedFetch({
        [urlFor('lever', lever.boardToken)]: () => jsonResponse(leverListed),
        [urlFor('ashby', ashby.boardToken)]: () => jsonResponse(ashbyPosts),
      });

      await run(impl, [lever.sourceId, ashby.sourceId]);
      const [company] = await dbHandle.db.select().from(schema.companies).where(eq(schema.companies.name, companyName));
      await dbHandle.db.insert(schema.jobs).values({
        companyId: company!.companyId,
        title: `Hand entered ${tag}`,
        source: 'manual',
        externalId: null,
        jobHash: `manual-${tag}`.padEnd(64, '0'),
      });

      leverListed = leverPosts.slice(0, 1);
      const report = await run(impl, [lever.sourceId, ashby.sourceId]);
      expect(report.deactivated).toBe(2);

      const jobs = await jobsOf(companyName);
      const state = Object.fromEntries(jobs.map((job) => [job.source === 'manual' ? 'manual' : job.externalId, job.isActive]));
      expect(state).toEqual({
        [`scope-l-${tag}-0`]: true,
        [`scope-l-${tag}-1`]: false,
        [`scope-l-${tag}-2`]: false,
        [`scope-a-${tag}`]: true,
        manual: true,
      });
    });

    it('does not deactivate anything when the board returns an empty list', async () => {
      const source = await makeSource('lever');
      let listed = leverPostings(`empty-${tag}`, 3);
      const { impl } = routedFetch({ [urlFor('lever', source.boardToken)]: () => jsonResponse(listed) });
      await run(impl, [source.sourceId]);

      listed = [];
      const report = await run(impl, [source.sourceId]);

      expect(report.deactivated).toBe(0);
      expect(report.sources[0]).toMatchObject({ status: 'ok', fetched: 0, deactivation_skipped: 'empty_result' });
      expect((await jobsOf(source.companyName)).every((job) => job.isActive)).toBe(true);
      expect(await sourceRow(source.sourceId)).toMatchObject({ lastStatus: 'ok', lastJobCount: 0 });
    });

    it('does not deactivate anything when the fetch fails, and keeps the last good count', async () => {
      const source = await makeSource('lever');
      let respond: Responder = () => jsonResponse(leverPostings(`fail-${tag}`, 3));
      const { impl } = routedFetch({ [urlFor('lever', source.boardToken)]: (url) => respond(url) });
      await run(impl, [source.sourceId]);

      const failures: Array<[string, Responder]> = [
        ['a server error', () => new Response('boom', { status: 500 })],
        ['a missing board', () => new Response('nope', { status: 404 })],
        ['an HTML error page', () => jsonResponse('<html>maintenance</html>')],
        ['the wrong JSON shape', () => jsonResponse({ ok: false, error: 'Site not found' })],
        ['a dropped connection', () => Promise.reject(new TypeError('fetch failed'))],
      ];
      for (const [label, failing] of failures) {
        respond = failing;
        const report = await run(impl, [source.sourceId]);
        expect(report, label).toMatchObject({ attempted: 1, succeeded: 0, failed: 1, deactivated: 0 });
        expect(report.sources[0]?.status, label).toBe('error');
        expect((await jobsOf(source.companyName)).every((job) => job.isActive), label).toBe(true);
        expect(await sourceRow(source.sourceId), label).toMatchObject({ lastStatus: 'error', lastJobCount: 3 });
      }
    });

    it('does not deactivate when a run was cut short by its time budget, and says so', async () => {
      const source = await makeSource('lever');
      const all = leverPostings(`budget-${tag}`, 4);
      let listed = all;
      const { impl } = routedFetch({ [urlFor('lever', source.boardToken)]: () => jsonResponse(listed) });
      await run(impl, [source.sourceId]);

      // Second run: one posting vanished and a new one appeared, but the clock jumps past the
      // deadline as soon as the first posting is stored.
      let clock = 1_000_000;
      beforePublish = () => {
        clock += 60_000;
      };
      listed = [...all.slice(0, 3), ...leverPostings(`budget-new-${tag}`, 2)];
      try {
        const report = await run(impl, [source.sourceId], { now: () => clock, postingConcurrency: 1 });
        expect(report.inserted).toBe(1);
        expect(report.deactivated).toBe(0);
        expect(report.sources[0]).toMatchObject({ status: 'partial', deactivation_skipped: 'incomplete_run' });
        expect(report.sources[0]?.error).toMatch(/time budget/);
        expect(await sourceRow(source.sourceId)).toMatchObject({ lastStatus: 'partial', lastJobCount: 5 });
      } finally {
        beforePublish = () => undefined;
      }
      expect((await jobsOf(source.companyName)).every((job) => job.isActive)).toBe(true);
    });

    it('does not deactivate when a posting could not be stored, because it might still be listed', async () => {
      const source = await makeSource('lever');
      const all = leverPostings(`reject-${tag}`, 4);
      let listed = all;
      const { impl } = routedFetch({ [urlFor('lever', source.boardToken)]: () => jsonResponse(listed) });
      await run(impl, [source.sourceId]);

      listed = [...all.slice(0, 2), ...leverPostings(`reject-new-${tag}`, 2)];
      beforePublish = (envelope) => {
        if ((envelope.payload as { title?: string }).title === `Engineer reject-new-${tag} 1`) throw new Error('broker is down: secret-ish detail');
      };
      try {
        const report = await run(impl, [source.sourceId]);
        expect(report).toMatchObject({ inserted: 1, rejected: 1, deactivated: 0 });
        expect(report.sources[0]).toMatchObject({ status: 'partial', deactivation_skipped: 'rejected_postings' });
        expect(report.sources[0]?.error).toBe('1 posting(s) could not be stored');
        expect(report.sources[0]?.error).not.toMatch(/secret-ish/);
      } finally {
        beforePublish = () => undefined;
      }
      expect((await jobsOf(source.companyName)).filter((job) => !job.isActive)).toHaveLength(0);
    });

    it('holds back a sharp drop until the next run sees the same thing', async () => {
      const source = await makeSource('lever');
      const all = leverPostings(`drop-${tag}`, 12);
      let listed = all;
      const { impl } = routedFetch({ [urlFor('lever', source.boardToken)]: () => jsonResponse(listed) });
      await run(impl, [source.sourceId]);
      expect(await sourceRow(source.sourceId)).toMatchObject({ lastJobCount: 12 });

      listed = all.slice(0, 1);
      const first = await run(impl, [source.sourceId]);
      expect(first.deactivated).toBe(0);
      expect(first.sources[0]).toMatchObject({ status: 'ok', fetched: 1, deactivation_skipped: 'sharp_drop' });
      expect((await jobsOf(source.companyName)).every((job) => job.isActive)).toBe(true);

      const second = await run(impl, [source.sourceId]);
      expect(second.deactivated).toBe(11);
      expect(second.sources[0]?.deactivation_skipped).toBeNull();
      const jobs = await jobsOf(source.companyName);
      expect(jobs.filter((job) => job.isActive).map((job) => job.externalId)).toEqual([`drop-${tag}-0`]);
    });
  });

  describe('the run as a whole', () => {
    it('skips a failing source, records why, and carries on with the rest', async () => {
      const broken = await makeSource('lever');
      const healthy = await makeSource('lever');
      const leak = 'internal-hostname.corp postgres://user:pw@db/x';
      const { impl, calls } = routedFetch({
        [urlFor('lever', broken.boardToken)]: () => new Response(leak, { status: 502 }),
        [urlFor('lever', healthy.boardToken)]: () => jsonResponse(leverPostings(`mixed-${tag}`, 2)),
      });

      const report = await run(impl, [broken.sourceId, healthy.sourceId], { sourceConcurrency: 1 });

      expect(calls).toHaveLength(2);
      expect(report).toMatchObject({ attempted: 2, succeeded: 1, failed: 1, not_attempted: 0, inserted: 2 });
      const byId = new Map(report.sources.map((entry) => [entry.source_id, entry]));
      expect(byId.get(broken.sourceId)).toMatchObject({ status: 'error', fetched: 0, inserted: 0 });
      expect(byId.get(healthy.sourceId)).toMatchObject({ status: 'ok', inserted: 2 });

      const brokenRow = await sourceRow(broken.sourceId);
      expect(brokenRow.lastStatus).toBe('error');
      expect(brokenRow.lastFetchedAt).not.toBeNull();
      expect(brokenRow.lastError).toMatch(/502/);
      expect(brokenRow.lastError!.length).toBeLessThanOrEqual(200);
      expect(brokenRow.lastError).not.toContain('internal-hostname');
      expect(await sourceRow(healthy.sourceId)).toMatchObject({ lastStatus: 'ok', lastError: null });
    });

    it('clears a previous error once the source works again', async () => {
      const source = await makeSource('lever');
      let ok = false;
      const { impl } = routedFetch({
        [urlFor('lever', source.boardToken)]: () => (ok ? jsonResponse(leverPostings(`recover-${tag}`, 1)) : new Response('x', { status: 500 })),
      });
      await run(impl, [source.sourceId]);
      expect((await sourceRow(source.sourceId)).lastError).not.toBeNull();

      ok = true;
      await run(impl, [source.sourceId]);
      expect(await sourceRow(source.sourceId)).toMatchObject({ lastStatus: 'ok', lastError: null, lastJobCount: 1 });
    });

    it('stores a fixed sentence, never a driver message, when the database fails', async () => {
      // 301 characters fit job_sources.company_name (text) but not companies.name (varchar 300).
      const source = await makeSource('lever', { companyName: `X${'y'.repeat(300)}` });
      const { impl } = routedFetch({ [urlFor('lever', source.boardToken)]: () => jsonResponse(leverPostings(`dberr-${tag}`, 1)) });

      const report = await run(impl, [source.sourceId]);

      expect(report.sources[0]).toMatchObject({ status: 'error', error: 'database error while storing postings' });
      const row = await sourceRow(source.sourceId);
      expect(row.lastError).toBe('database error while storing postings');
      expect(row.lastError).not.toMatch(/insert|varchar|value too long/i);
    });

    it('reads the least recently fetched sources first, never-fetched ones leading', async () => {
      const recent = await makeSource('lever');
      const stale = await makeSource('lever');
      const never = await makeSource('lever');
      await dbHandle.db.update(schema.jobSources).set({ lastFetchedAt: sql`now()` }).where(eq(schema.jobSources.sourceId, recent.sourceId));
      await dbHandle.db.update(schema.jobSources).set({ lastFetchedAt: sql`now() - interval '3 days'` }).where(eq(schema.jobSources.sourceId, stale.sourceId));
      const { impl, calls } = routedFetch({});

      const report = await run(impl, [recent.sourceId, stale.sourceId, never.sourceId], { sourceConcurrency: 1, limit: 2 });

      expect(calls).toEqual([urlFor('lever', never.boardToken), urlFor('lever', stale.boardToken)]);
      expect(report).toMatchObject({ attempted: 2, not_attempted: 1 });
      // Every attempt moves the source to the back of the line, failed or not.
      const [neverAfter, recentAfter] = await Promise.all([sourceRow(never.sourceId), sourceRow(recent.sourceId)]);
      expect(Date.parse(neverAfter.lastFetchedAt!)).toBeGreaterThan(Date.parse(recentAfter.lastFetchedAt!) - 1);
    });

    it('does not start another board when too little of the budget is left', async () => {
      const first = await makeSource('lever');
      const second = await makeSource('lever');
      let clock = 5_000_000;
      const { impl, calls } = routedFetch({
        [urlFor('lever', first.boardToken)]: () => {
          // A slow board: it leaves less than the minimum window for the next one.
          clock += 20_000 - MIN_WINDOW_TO_START_SOURCE_MS + 1;
          return jsonResponse(leverPostings(`slow-${tag}`, 1));
        },
        [urlFor('lever', second.boardToken)]: () => jsonResponse(leverPostings(`slow2-${tag}`, 1)),
      });
      // Order is by created_at once neither has been fetched.
      const report = await run(impl, [first.sourceId, second.sourceId], { sourceConcurrency: 1, now: () => clock });

      expect(calls).toEqual([urlFor('lever', first.boardToken)]);
      expect(report).toMatchObject({ attempted: 1, succeeded: 1, not_attempted: 1, inserted: 1 });
      // The skipped board keeps its place at the front for the next run.
      expect((await sourceRow(second.sourceId)).lastFetchedAt).toBeNull();
    });

    it('reads at most the configured number of boards at once', async () => {
      const sources = await Promise.all(Array.from({ length: 6 }, () => makeSource('lever')));
      let inFlight = 0;
      let peak = 0;
      const responders: Record<string, Responder> = {};
      for (const source of sources) {
        responders[urlFor('lever', source.boardToken)] = async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 40));
          inFlight -= 1;
          return jsonResponse([]);
        };
      }
      const { impl } = routedFetch(responders);

      const report = await run(impl, sources.map((source) => source.sourceId), { sourceConcurrency: 2 });

      expect(report.attempted).toBe(6);
      expect(peak).toBe(2);
    });

    it('does not read a disabled source', async () => {
      const off = await makeSource('lever', { enabled: false });
      const { impl, calls } = routedFetch({});

      const report = await run(impl, [off.sourceId]);

      expect(calls).toEqual([]);
      expect(report).toMatchObject({ sources_total: 0, attempted: 0 });
      expect((await sourceRow(off.sourceId)).lastFetchedAt).toBeNull();
    });
  });
});
