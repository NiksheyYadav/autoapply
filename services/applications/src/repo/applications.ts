import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type {
  Application,
  ApplicationJobSummary,
  ApplicationMode,
  ApplicationStatus,
  ApplicationWithJob,
  PaginationQuery,
} from '@atlas/types';
import { encodeCursor, parseTimeCursor } from '@atlas/utils';
import { jobSummaryColumns, toJobSummary } from './lookups.js';

export type ApplicationRow = typeof schema.applications.$inferSelect;

export function toApplication(row: ApplicationRow): Application {
  return {
    application_id: row.applicationId,
    user_id: row.userId,
    job_id: row.jobId,
    resume_id: row.resumeId,
    organization_id: row.organizationId,
    status: row.status,
    mode: row.mode,
    idempotency_key: row.idempotencyKey,
    submitted_at: row.submittedAt,
    last_event_at: row.lastEventAt,
    failure_reason: row.failureReason,
    created_at: row.createdAt,
  };
}

export async function findById(db: Database, applicationId: string): Promise<ApplicationRow | null> {
  const [row] = await db
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.applicationId, applicationId))
    .limit(1);
  return row ?? null;
}

/** An application row together with its job summary — what the owner's view is built from. */
export interface ApplicationWithJobRow {
  application: ApplicationRow;
  job: ApplicationJobSummary | null;
}

/** The owner's view of an application. Staff views use {@link toApplication}, which cannot carry a job. */
export function toApplicationWithJob(row: ApplicationRow, job: ApplicationJobSummary | null): ApplicationWithJob {
  return { ...toApplication(row), job };
}

/**
 * `findById` plus the job summary in a single query. LEFT joins, so an
 * application whose job or company row is gone still comes back (with
 * `job: null`) instead of vanishing.
 */
export async function findByIdWithJob(db: Database, applicationId: string): Promise<ApplicationWithJobRow | null> {
  const [row] = await db
    .select({ application: schema.applications, job: jobSummaryColumns })
    .from(schema.applications)
    .leftJoin(schema.jobs, eq(schema.jobs.jobId, schema.applications.jobId))
    .leftJoin(schema.companies, eq(schema.companies.companyId, schema.jobs.companyId))
    .where(eq(schema.applications.applicationId, applicationId))
    .limit(1);
  return row ? { application: row.application, job: toJobSummary(row.job) } : null;
}

export async function findByUserAndJob(db: Database, userId: string, jobId: string): Promise<ApplicationRow | null> {
  const [row] = await db
    .select()
    .from(schema.applications)
    .where(and(eq(schema.applications.userId, userId), eq(schema.applications.jobId, jobId)))
    .limit(1);
  return row ?? null;
}

export async function findByUserAndIdempotencyKey(
  db: Database,
  userId: string,
  idempotencyKey: string,
): Promise<ApplicationRow | null> {
  const [row] = await db
    .select()
    .from(schema.applications)
    .where(and(eq(schema.applications.userId, userId), eq(schema.applications.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row ?? null;
}

export interface InsertApplicationInput {
  userId: string;
  jobId: string;
  resumeId: string;
  organizationId: string | null;
  mode: ApplicationMode;
  status: ApplicationStatus;
  idempotencyKey: string;
}

export async function insertApplication(db: Database, input: InsertApplicationInput): Promise<ApplicationRow> {
  const [row] = await db.insert(schema.applications).values(input).returning();
  if (!row) throw new Error('insertApplication: insert returned no row');
  return row;
}

export interface ListForUserResult {
  items: ApplicationWithJobRow[];
  nextCursor: string | null;
}

/** Staff pagination result: plain application rows, deliberately without any job context. */
export interface ListForOrganizationResult {
  items: ApplicationRow[];
  nextCursor: string | null;
}

function pageCondition(scopeCondition: SQL, pagination: PaginationQuery): SQL | undefined {
  const cursor = parseTimeCursor(pagination.cursor);
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const conditions = [scopeCondition];
  if (cursorCreatedAt && cursorId) {
    // `created_at` alone isn't unique — a secondary key at the page boundary
    // keeps ties from being silently dropped (the same fix applied across
    // resumes/jobs/scores pagination after the PR #3 review).
    const tieBreak = or(
      lt(schema.applications.createdAt, cursorCreatedAt),
      and(eq(schema.applications.createdAt, cursorCreatedAt), lt(schema.applications.applicationId, cursorId)),
    );
    if (tieBreak) conditions.push(tieBreak);
  }
  return and(...conditions);
}

function toPage<T>(
  rows: T[],
  limit: number,
  applicationOf: (item: T) => ApplicationRow,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const lastApplication = last === undefined ? null : applicationOf(last);
  return {
    items,
    nextCursor:
      hasMore && lastApplication
        ? encodeCursor({ createdAt: lastApplication.createdAt, id: lastApplication.applicationId })
        : null,
  };
}

/**
 * The caller's own applications with job context, in ONE query: a LEFT JOIN on
 * the jobs and companies primary keys is 1:1 with `applications`, so the
 * ordering, `limit + 1` page detection and cursor all behave exactly as they do
 * for the plain table.
 */
export interface ListForUserFilter {
  /** Restrict to applications for one job (the caller's own, so this reveals nothing new). */
  jobId?: string | undefined;
}

export async function listForUser(
  db: Database,
  userId: string,
  pagination: PaginationQuery,
  filter: ListForUserFilter = {},
): Promise<ListForUserResult> {
  const scopeCondition =
    filter.jobId === undefined
      ? eq(schema.applications.userId, userId)
      : (and(eq(schema.applications.userId, userId), eq(schema.applications.jobId, filter.jobId)) as SQL);
  const rows = await db
    .select({ application: schema.applications, job: jobSummaryColumns })
    .from(schema.applications)
    .leftJoin(schema.jobs, eq(schema.jobs.jobId, schema.applications.jobId))
    .leftJoin(schema.companies, eq(schema.companies.companyId, schema.jobs.companyId))
    .where(pageCondition(scopeCondition, pagination))
    .orderBy(desc(schema.applications.createdAt), desc(schema.applications.applicationId))
    .limit(pagination.limit + 1);

  const page = toPage(rows, pagination.limit, (item) => item.application);
  return {
    items: page.items.map((item) => ({ application: item.application, job: toJobSummary(item.job) })),
    nextCursor: page.nextCursor,
  };
}

/**
 * Org-wide view for admin/owner staff (apps/admin) — same pagination contract
 * as `listForUser`, but a plain single-table read. Staff see application
 * counts/statuses only (no job or employer names), so no job columns are ever
 * selected on this path.
 */
export async function listForOrganization(
  db: Database,
  organizationId: string,
  pagination: PaginationQuery,
): Promise<ListForOrganizationResult> {
  const rows = await db
    .select()
    .from(schema.applications)
    .where(pageCondition(eq(schema.applications.organizationId, organizationId), pagination))
    .orderBy(desc(schema.applications.createdAt), desc(schema.applications.applicationId))
    .limit(pagination.limit + 1);

  return toPage(rows, pagination.limit, (item) => item);
}

export interface AppendEventInput {
  applicationId: string;
  fromStatus: ApplicationStatus;
  toStatus: ApplicationStatus;
  note: string | null;
}

/**
 * Folds the new status onto `applications` and appends the trail row in one transaction.
 *
 * The update only applies while the application is still in `fromStatus`, the status the caller
 * validated the move against. Without that, two requests that both read "interviewing" would both
 * pass validation and both write, so an application could go "rejected" and then "offer", the
 * trail would show two moves out of the same status, and a duplicate "submitted" would publish
 * twice. Returns `null` when the application is no longer in `fromStatus`: someone else moved it
 * first, and nothing was written.
 */
export async function appendEvent(db: Database, input: AppendEventInput): Promise<ApplicationRow | null> {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const [updated] = await tx
      .update(schema.applications)
      .set({
        status: input.toStatus,
        lastEventAt: now,
        submittedAt: input.toStatus === 'submitted' ? now : undefined,
      })
      .where(
        and(
          eq(schema.applications.applicationId, input.applicationId),
          eq(schema.applications.status, input.fromStatus),
        ),
      )
      .returning();
    if (!updated) return null;

    await tx.insert(schema.applicationEvents).values({
      applicationId: input.applicationId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      note: input.note,
    });

    return updated;
  });
}
