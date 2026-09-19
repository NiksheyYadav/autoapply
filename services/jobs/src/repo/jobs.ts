import { and, desc, eq, ilike, lt } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { EmploymentType, Job, JobSource, PaginationQuery, RemoteType } from '@atlas/types';
import { decodeCursor, encodeCursor } from '@atlas/utils';

type JobRow = typeof schema.jobs.$inferSelect;

export function toJob(row: JobRow): Job {
  return {
    job_id: row.jobId,
    company_id: row.companyId,
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

/** A source re-reported a listing we already have — bump its freshness instead of duplicating it. */
export async function touchSeen(db: Database, jobId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(schema.jobs)
    .set({ lastSeenAt: now, isActive: true, updatedAt: now })
    .where(eq(schema.jobs.jobId, jobId));
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

  const conditions = [];
  if (filters.isActive !== undefined) conditions.push(eq(schema.jobs.isActive, filters.isActive));
  if (filters.remoteType) conditions.push(eq(schema.jobs.remoteType, filters.remoteType));
  if (filters.location) conditions.push(ilike(schema.jobs.location, `%${filters.location}%`));
  if (cursorCreatedAt) conditions.push(lt(schema.jobs.createdAt, cursorCreatedAt));

  const rows = await db
    .select()
    .from(schema.jobs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.jobs.createdAt))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const items = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt }) : null };
}
