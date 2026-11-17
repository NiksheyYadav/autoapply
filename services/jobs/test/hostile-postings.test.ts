import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import type { EventBroker } from '@atlas/messaging';
import { createSilentLogger } from '@atlas/utils';
import { runSourceIngestion } from '../src/lib/run-sources.js';
import { upsert } from '../src/repo/job-sources.js';

// DB-backed: self-skips when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

/**
 * A job board is somebody else's server, so what it returns is hostile input: the postings land in
 * the shared catalog that every user reads. These feed one board a mix of hostile and ordinary
 * postings and check that the ordinary ones still arrive and nothing hostile is stored as is.
 */
describe.skipIf(!testDatabaseUrl)('a job board that sends hostile postings', () => {
  let dbHandle: DatabaseHandle;
  const tag = randomUUID().slice(0, 8);
  const companyName = `Hostile Co ${tag}`;
  const sourceIds: string[] = [];

  const broker: EventBroker = {
    publish: async () => undefined,
    subscribe: async (options) => ({ consumer: options.consumer, stop: async () => undefined }),
    isHealthy: () => true,
    close: async () => undefined,
  };

  beforeAll(() => {
    dbHandle = createDatabase({ url: testDatabaseUrl!, maxConnections: 4 });
  });

  afterAll(async () => {
    const [company] = await dbHandle.db.select().from(schema.companies).where(eq(schema.companies.name, companyName));
    if (company) {
      await dbHandle.db.delete(schema.jobs).where(eq(schema.jobs.companyId, company.companyId));
      await dbHandle.db.delete(schema.companies).where(eq(schema.companies.companyId, company.companyId));
    }
    if (sourceIds.length > 0) {
      await dbHandle.db.delete(schema.jobSources).where(inArray(schema.jobSources.sourceId, sourceIds));
    }
    await dbHandle.close();
  });

  async function ingest(jobs: unknown[]) {
    const { row } = await upsert(dbHandle.db, {
      provider: 'greenhouse',
      boardToken: `host-${tag}`,
      companyName,
    });
    sourceIds.push(row.sourceId);
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ jobs }), { status: 200, headers: { 'content-type': 'application/json' } });
    const report = await runSourceIngestion(
      { db: dbHandle.db, broker, logger: createSilentLogger(), fetch: fetchImpl, userAgent: 'AtlasJobIngest/test' },
      { budgetMs: 20_000, sourceIds: [row.sourceId] },
    );
    const stored = await dbHandle.db
      .select({ job: schema.jobs })
      .from(schema.jobs)
      .innerJoin(schema.companies, eq(schema.jobs.companyId, schema.companies.companyId))
      .where(eq(schema.companies.name, companyName))
      .then((rows) => rows.map((entry) => entry.job));
    return { report, stored };
  }

  it('stores the ordinary postings, drops or cleans the hostile ones, and never stores a NUL or a script link', async () => {
    const { report, stored } = await ingest([
      { id: 9001, title: `Good Engineer ${tag}`, content: 'Build services in TypeScript.', absolute_url: 'https://boards.greenhouse.io/x/jobs/9001', location: { name: 'Berlin' } },
      { id: 9002, title: `Nul Title\u0000 ${tag}`, content: 'Fine description', absolute_url: 'https://boards.greenhouse.io/x/jobs/9002' },
      { id: 9003, title: `Nul Body ${tag}`, content: 'Description with a \u0000 inside', location: { name: 'Ber\u0000lin' }, absolute_url: 'https://boards.greenhouse.io/x/jobs/9003' },
      { id: 9004, title: `Script Link ${tag}`, content: 'x', absolute_url: 'javascript:alert(document.cookie)' },
      { id: 9005, title: `Data Link ${tag}`, content: 'x', absolute_url: 'data:text/html,<script>alert(1)</script>' },
      { id: 9006, title: `Control Chars ${tag} \u0007\u001b[31mred‮evil`, content: 'x​x', absolute_url: 'https://boards.greenhouse.io/x/jobs/9006' },
      { id: 9007, title: `Huge ${tag} ${'x'.repeat(100_000)}`, content: 'y'.repeat(500_000), absolute_url: 'https://boards.greenhouse.io/x/jobs/9007' },
      { id: 9008, title: `Markup ${tag} <img src=x onerror=alert(1)>`, content: '<script>alert(1)</script><p>Real text</p>', absolute_url: 'https://boards.greenhouse.io/x/jobs/9008' },
      { id: 'not-a-number-but-allowed', title: `String Id ${tag}`, content: 'x', absolute_url: 'https://boards.greenhouse.io/x/jobs/9009' },
      { id: null, title: 'No id at all' },
      'a string, not an object',
      null,
      { id: 9010 },
    ]);

    // The run as a whole worked: one hostile posting must not take the board down.
    expect(report.failed).toBe(0);
    expect(report.succeeded).toBe(1);
    expect(stored.map((job) => job.title)).toContain(`Good Engineer ${tag}`);

    // A NUL used to make its posting unstorable, and a single unstorable posting stops the board's
    // closed roles from ever being deactivated. It is cleaned instead, so nothing is rejected.
    expect(report.rejected).toBe(0);
    expect(report.sources[0]?.deactivation_skipped).not.toBe('rejected_postings');
    expect(stored.map((job) => job.title)).toContain(`Nul Title ${tag}`);
    expect(stored.find((job) => job.title === `Nul Body ${tag}`)?.location).toBe('Berlin');

    for (const job of stored) {
      const strings = [job.title, job.description, job.location, job.applyUrl].filter((value): value is string => typeof value === 'string');
      for (const text of strings) expect(text.includes('\u0000')).toBe(false);
      // Controls other than tab, newline and carriage return, and bidi overrides, are gone.
      for (const text of [job.title, job.description ?? '', job.location ?? '']) {
        // eslint-disable-next-line no-control-regex
        expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
      }
      if (job.applyUrl !== null) expect(job.applyUrl).toMatch(/^https?:\/\//);
      expect(job.title.length).toBeLessThanOrEqual(300);
      expect((job.description ?? '').length).toBeLessThanOrEqual(200_000);
      expect(job.description ?? '').not.toMatch(/<script/i);
    }
  });
});
