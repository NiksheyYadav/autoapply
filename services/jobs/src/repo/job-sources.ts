import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { JobBoardProvider, JobBoardSource, JobBoardSourceStatus } from '@atlas/types';

type SourceRow = typeof schema.jobSources.$inferSelect;

/** Postgres' text form of a timestamptz ("2026-10-27 13:47:51.123+00") as the ISO-8601 the API contract promises. */
function toIso(value: string | null): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function toJobBoardSource(row: SourceRow): JobBoardSource {
  return {
    source_id: row.sourceId,
    provider: row.provider,
    board_token: row.boardToken,
    company_name: row.companyName,
    enabled: row.enabled,
    last_fetched_at: toIso(row.lastFetchedAt),
    last_status: row.lastStatus,
    last_error: row.lastError,
    last_job_count: row.lastJobCount,
    // `created_at` is NOT NULL, so there is always a date to report.
    created_at: toIso(row.createdAt) ?? new Date(0).toISOString(),
  };
}

/** Every source, newest board last: stable for display, and small enough not to page. */
export async function listAll(db: Database, limit = 500): Promise<SourceRow[]> {
  return db
    .select()
    .from(schema.jobSources)
    .orderBy(asc(schema.jobSources.provider), asc(schema.jobSources.boardToken))
    .limit(limit);
}

export async function listByProvider(db: Database, provider: JobBoardProvider): Promise<SourceRow[]> {
  return db.select().from(schema.jobSources).where(eq(schema.jobSources.provider, provider));
}

export async function countEnabled(db: Database, onlySourceIds?: readonly string[]): Promise<number> {
  if (onlySourceIds !== undefined && onlySourceIds.length === 0) return 0;
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.jobSources)
    .where(
      and(
        eq(schema.jobSources.enabled, true),
        onlySourceIds === undefined ? undefined : inArray(schema.jobSources.sourceId, [...onlySourceIds]),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Enabled sources, least recently fetched first (never-fetched ones lead). `last_fetched_at` moves
 * on every attempt, failed or not, so a broken board goes to the back of the line instead of
 * blocking the healthy ones behind it.
 */
export async function listDue(db: Database, limit: number, onlySourceIds?: readonly string[]): Promise<SourceRow[]> {
  if (onlySourceIds !== undefined && onlySourceIds.length === 0) return [];
  return db
    .select()
    .from(schema.jobSources)
    .where(
      and(
        eq(schema.jobSources.enabled, true),
        onlySourceIds === undefined ? undefined : inArray(schema.jobSources.sourceId, [...onlySourceIds]),
      ),
    )
    .orderBy(
      sql`${schema.jobSources.lastFetchedAt} ASC NULLS FIRST`,
      asc(schema.jobSources.createdAt),
      asc(schema.jobSources.sourceId),
    )
    .limit(limit);
}

export interface UpsertSourceInput {
  provider: JobBoardProvider;
  boardToken: string;
  companyName: string;
  enabled?: boolean;
}

/**
 * Creates the source, or updates the company name (and the enabled flag, if given) of the one
 * already stored for that provider and token. `created` comes from `xmax = 0`, which is true only
 * for a row this very statement inserted.
 */
export async function upsert(
  db: Database,
  input: UpsertSourceInput,
): Promise<{ row: SourceRow; created: boolean }> {
  const [result] = await db
    .insert(schema.jobSources)
    .values({
      provider: input.provider,
      boardToken: input.boardToken,
      companyName: input.companyName,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    })
    .onConflictDoUpdate({
      target: [schema.jobSources.provider, schema.jobSources.boardToken],
      set: {
        companyName: input.companyName,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
    })
    .returning({ ...getTableColumns(schema.jobSources), created: sql<boolean>`(xmax = 0)` });
  if (!result) throw new Error('upsert: job source upsert returned no row');
  const { created, ...row } = result;
  return { row, created };
}

export interface RecordedRun {
  status: JobBoardSourceStatus;
  /** Short and scrubbed; null on a clean run. */
  error: string | null;
  /** The number of postings the source listed; left as is for a failed fetch. */
  jobCount?: number;
}

/** Stamps the outcome of an attempt, using the database clock. */
export async function recordRun(db: Database, sourceId: string, run: RecordedRun): Promise<void> {
  await db
    .update(schema.jobSources)
    .set({
      lastFetchedAt: sql`now()`,
      lastStatus: run.status,
      lastError: run.error,
      ...(run.jobCount === undefined ? {} : { lastJobCount: run.jobCount }),
    })
    .where(eq(schema.jobSources.sourceId, sourceId));
}

/** The database's current time, as an ISO-8601 string with microseconds (`timestamptz` text form). */
export async function databaseNow(db: Database): Promise<string> {
  const rows = await db.execute<{ now: string }>(sql`select now()::text as now`);
  const first = rows[0];
  if (!first) throw new Error('databaseNow: no row returned');
  return first.now;
}
