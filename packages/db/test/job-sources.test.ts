import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { jobSources } from '../src/schema/index.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

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
