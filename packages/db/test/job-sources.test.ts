import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOARD_TOKEN_PATTERN, JOB_BOARD_PROVIDERS } from '@atlas/types';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { jobSources } from '../src/schema/index.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

const seedPath = fileURLToPath(new URL('../seed/job-sources.example.sql', import.meta.url));
const seedSql = readFileSync(seedPath, 'utf8');

/** The `('provider', 'token', 'Company')` tuples in the example seed, comments aside. */
function seedRows(): Array<{ provider: string; boardToken: string; companyName: string }> {
  const code = seedSql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return [...code.matchAll(/\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g)].map((match) => ({
    provider: match[1]!,
    boardToken: match[2]!,
    companyName: match[3]!,
  }));
}

describe('seed/job-sources.example.sql', () => {
  it('lists boards whose providers and tokens the table will accept', () => {
    const rows = seedRows();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(JOB_BOARD_PROVIDERS as readonly string[], row.boardToken).toContain(row.provider);
      expect(BOARD_TOKEN_PATTERN.test(row.boardToken), row.boardToken).toBe(true);
      expect(row.companyName.trim(), row.boardToken).not.toBe('');
    }
  });

  it('never repeats a board, or gives one provider two boards under one company name', () => {
    const rows = seedRows();
    const boards = rows.map((row) => `${row.provider}/${row.boardToken}`);
    expect(new Set(boards).size).toBe(boards.length);
    const names = rows.map((row) => `${row.provider}/${row.companyName.toLowerCase()}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is safe to run again: it only ever inserts, and does nothing on conflict', () => {
    expect(seedSql).toMatch(/ON CONFLICT \(provider, board_token\) DO NOTHING;\s*$/);
    expect(seedSql).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  });
});

function pgCode(error: unknown): string {
  const direct = (error as { code?: unknown } | null)?.code;
  const nested = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return String(direct ?? nested ?? '');
}

describe.skipIf(!testDatabaseUrl)('job_sources constraints, against Postgres', () => {
  let dbHandle: DatabaseHandle;
  const tag = randomUUID().slice(0, 8);
  const created: string[] = [];

  beforeAll(() => {
    dbHandle = createDatabase({ url: testDatabaseUrl!, maxConnections: 2 });
  });

  afterAll(async () => {
    if (created.length > 0) {
      await dbHandle.db.delete(jobSources).where(inArray(jobSources.sourceId, created));
    }
    await dbHandle.close();
  });

  it('stores a source with the documented defaults', async () => {
    const [row] = await dbHandle.db
      .insert(jobSources)
      .values({ provider: 'greenhouse', boardToken: `db-${tag}-a`, companyName: 'Acme' })
      .returning();
    created.push(row!.sourceId);

    expect(row).toMatchObject({
      provider: 'greenhouse',
      enabled: true,
      lastFetchedAt: null,
      lastStatus: null,
      lastError: null,
      lastJobCount: null,
    });
    expect(row!.createdAt).toEqual(expect.any(String));
  });

  it('allows the same token under a different provider but not twice under one', async () => {
    const boardToken = `db-${tag}-b`;
    const [first] = await dbHandle.db
      .insert(jobSources)
      .values({ provider: 'lever', boardToken, companyName: 'Acme' })
      .returning();
    const [otherProvider] = await dbHandle.db
      .insert(jobSources)
      .values({ provider: 'ashby', boardToken, companyName: 'Acme' })
      .returning();
    created.push(first!.sourceId, otherProvider!.sourceId);

    const duplicate = await dbHandle.db
      .insert(jobSources)
      .values({ provider: 'lever', boardToken, companyName: 'Acme Again' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(pgCode(duplicate)).toBe('23505');
  });

  it.each([
    ['a path traversal', '../admin'],
    ['a dotted hostname', 'evil.example.com'],
    ['a slash', 'a/b'],
    ['a query string', 'a?x=1'],
    ['userinfo', 'user@host'],
    ['a port', 'host:8080'],
    ['whitespace', 'a b'],
    ['a leading hyphen', '-lead'],
    ['an empty token', ''],
    ['an overlong token', 'a'.repeat(101)],
  ])('refuses %s as a board token', async (_label, boardToken) => {
    const rejected = await dbHandle.db
      .insert(jobSources)
      .values({ provider: 'greenhouse', boardToken, companyName: 'Evil' })
      .returning()
      .then(
        (rows) => {
          created.push(...rows.map((row) => row.sourceId));
          return null;
        },
        (error: unknown) => error,
      );
    expect(pgCode(rejected)).toBe('23514');
    const stored = await dbHandle.db.select().from(jobSources).where(eq(jobSources.boardToken, boardToken));
    expect(stored).toHaveLength(0);
  });

  it('applies the example seed, and applying it again changes nothing', async () => {
    class Rollback extends Error {}
    const rows = seedRows();
    const tokens = rows.map((row) => row.boardToken);
    const counts: number[] = [];
    await dbHandle.sql
      .begin(async (tx) => {
        // Everything below is rolled back, so the database is left exactly as it was. The seed's own
        // boards are cleared first so the count does not depend on what a real seed run left behind.
        await tx`delete from job_sources where board_token in ${tx(tokens)}`;
        const before = await tx<{ n: number }[]>`select count(*)::int as n from job_sources`;
        await tx.unsafe(seedSql);
        const afterFirst = await tx<{ n: number }[]>`select count(*)::int as n from job_sources`;
        await tx.unsafe(seedSql);
        const afterSecond = await tx<{ n: number }[]>`select count(*)::int as n from job_sources`;
        counts.push(before[0]!.n, afterFirst[0]!.n, afterSecond[0]!.n);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });

    const [before, afterFirst, afterSecond] = counts as [number, number, number];
    expect(afterFirst - before).toBe(rows.length);
    expect(afterSecond).toBe(afterFirst);
  });

  it('refuses a provider outside the supported set', async () => {
    const rejected = await dbHandle.db
      .insert(jobSources)
      .values({ provider: 'workday' as 'lever', boardToken: `db-${tag}-c`, companyName: 'Acme' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    // invalid_text_representation: not a member of the enum.
    expect(pgCode(rejected)).toBe('22P02');
  });
});
