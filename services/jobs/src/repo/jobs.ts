import { and, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { EmploymentType, Job, JobSource, PaginationQuery, RemoteType } from '@atlas/types';
import { decodeCursor, encodeCursor } from '@atlas/utils';

type JobRow = typeof schema.jobs.$inferSelect;

/** `company_id` to display name for the given companies, in one query. Ids with no row are absent. */
export async function companyNamesByIds(db: Database, companyIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(companyIds)];
  if (unique.length === 0) return names;
  const rows = await db
    .select({ companyId: schema.companies.companyId, name: schema.companies.name })
    .from(schema.companies)
    .where(inArray(schema.companies.companyId, unique));
  for (const row of rows) names.set(row.companyId, row.name);
  return names;
}

/** `companyName` is the employer's display name; `null` when its company row is gone. */
export function toJob(row: JobRow, companyName: string | null = null): Job {
  return {
    job_id: row.jobId,
    company_id: row.companyId,
    company_name: companyName,
    title: row.title,
    description: row.description,
    salary_min: row.salaryMin,
    salary_max: row.salaryMax,
    salary_currency: row.salaryCurrency,
    location: row.location,
    remote_type: row.remoteType,
    employment_type: row.employmentType,
    source: row.source,
    external_id: row.externalId,
    apply_url: row.applyUrl,
    job_hash: row.jobHash,
    skills: row.skills.slice(0, 200),
    posted_at: row.postedAt,
    expires_at: row.expiresAt,
    is_active: row.isActive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function findByHash(db: Database, jobHash: string): Promise<JobRow | null> {
  const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.jobHash, jobHash)).limit(1);
  return row ?? null;
}

export async function findById(db: Database, jobId: string): Promise<JobRow | null> {
  const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.jobId, jobId)).limit(1);
  return row ?? null;
}

export interface InsertJobInput {
  companyId: string;
  title: string;
  description: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  location: string | null;
  remoteType: RemoteType;
  employmentType: EmploymentType;
  source: JobSource;
  externalId: string | null;
  applyUrl: string | null;
  jobHash: string;
  skills: string[];
  spamScore: number;
  postedAt: string | null;
}

export async function insert(db: Database, input: InsertJobInput): Promise<JobRow> {
  const [row] = await db.insert(schema.jobs).values(input).returning();
  if (!row) throw new Error('insert: job insert returned no row');
  return row;
}

/**
 * A source re-reported a listing we already have — bump its freshness instead of duplicating it.
 * Timestamps come from the database clock, never the service's: ingestion compares `last_seen_at`
 * with a database `now()` to find listings a source stopped reporting, and two clocks would make
 * that comparison depend on how far they have drifted apart.
 */
export async function touchSeen(db: Database, jobId: string): Promise<void> {
  await db
    .update(schema.jobs)
    .set({ lastSeenAt: sql`now()`, isActive: true, updatedAt: sql`now()` })
    .where(eq(schema.jobs.jobId, jobId));
}

/** Chunk size for `IN (...)` lists: well under Postgres' bind-parameter limit. */
const ID_CHUNK = 500;

function chunk<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += ID_CHUNK) chunks.push(items.slice(index, index + ID_CHUNK));
  return chunks;
}

/** `job_hash` to `job_id` for every hash that already has a row. */
export async function findJobIdsByHashes(db: Database, hashes: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const part of chunk([...new Set(hashes)])) {
    const rows = await db
      .select({ jobId: schema.jobs.jobId, jobHash: schema.jobs.jobHash })
      .from(schema.jobs)
      .where(inArray(schema.jobs.jobHash, part));
    for (const row of rows) found.set(row.jobHash, row.jobId);
  }
  return found;
}

/** {@link touchSeen} for many listings at once: a handful of statements however many there are. */
export async function touchSeenMany(db: Database, jobIds: readonly string[]): Promise<void> {
  for (const part of chunk([...new Set(jobIds)])) {
    await db
      .update(schema.jobs)
      .set({ lastSeenAt: sql`now()`, isActive: true, updatedAt: sql`now()` })
      .where(inArray(schema.jobs.jobId, part));
  }
}

export async function findBySourceExternalId(
  db: Database,
  source: JobSource,
  externalId: string,
): Promise<JobRow | null> {
  const [row] = await db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.source, source), eq(schema.jobs.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

export type UpdateJobInput = Omit<InsertJobInput, 'source' | 'externalId' | 'companyId'>;

/** Rewrites a stored listing whose source now publishes it differently (new title, location, ...). */
export async function updateInPlace(db: Database, jobId: string, input: UpdateJobInput): Promise<void> {
  await db
    .update(schema.jobs)
    .set({ ...input, isActive: true, lastSeenAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(schema.jobs.jobId, jobId));
}

/**
 * Marks a source's listings inactive when the source has not reported them since `before` (a
 * database timestamp taken when the run began). Only listings the source itself created are in
 * scope: same provider, same company. Returns how many it deactivated.
 */
export async function deactivateUnseenSince(
  db: Database,
  scope: { source: JobSource; companyId: string },
  before: string,
): Promise<number> {
  const rows = await db
    .update(schema.jobs)
    .set({ isActive: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(schema.jobs.source, scope.source),
        eq(schema.jobs.companyId, scope.companyId),
        eq(schema.jobs.isActive, true),
        lt(schema.jobs.lastSeenAt, before),
      ),
    )
    .returning({ jobId: schema.jobs.jobId });
  return rows.length;
}

export interface ListActiveFilters {
  location?: string;
  remoteType?: RemoteType;
  isActive?: boolean;
}

export interface ListJobsResult {
  items: JobRow[];
  nextCursor: string | null;
}

export async function listActive(
  db: Database,
  filters: ListActiveFilters,
  pagination: PaginationQuery,
): Promise<ListJobsResult> {
  const cursorValue = pagination.cursor ? decodeCursor(pagination.cursor) : null;
  const cursorCreatedAt = typeof cursorValue?.createdAt === 'string' ? cursorValue.createdAt : null;
  const cursorId = typeof cursorValue?.id === 'string' ? cursorValue.id : null;

  const conditions = [];
  if (filters.isActive !== undefined) conditions.push(eq(schema.jobs.isActive, filters.isActive));
  if (filters.remoteType) conditions.push(eq(schema.jobs.remoteType, filters.remoteType));
  if (filters.location) conditions.push(ilike(schema.jobs.location, `%${filters.location}%`));
  if (cursorCreatedAt && cursorId) {
    // `created_at` alone isn't unique — ties at the page boundary need a
    // secondary key or the next page silently drops every other row sharing
    // that exact timestamp, not just the ones already returned.
    conditions.push(
      or(
        lt(schema.jobs.createdAt, cursorCreatedAt),
        and(eq(schema.jobs.createdAt, cursorCreatedAt), lt(schema.jobs.jobId, cursorId)),
      ),
    );
  }

  const rows = await db
    .select()
    .from(schema.jobs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.jobs.createdAt), desc(schema.jobs.jobId))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const items = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.jobId }) : null,
  };
}
