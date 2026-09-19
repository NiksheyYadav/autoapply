import { and, desc, eq, lt, or } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Application, ApplicationMode, ApplicationStatus, PaginationQuery } from '@atlas/types';
import { decodeCursor, encodeCursor } from '@atlas/utils';

type ApplicationRow = typeof schema.applications.$inferSelect;

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
  items: ApplicationRow[];
  nextCursor: string | null;
}

export async function listForUser(
  db: Database,
  userId: string,
  pagination: PaginationQuery,
): Promise<ListForUserResult> {
  const cursorValue = pagination.cursor ? decodeCursor(pagination.cursor) : null;
  const cursorCreatedAt = typeof cursorValue?.createdAt === 'string' ? cursorValue.createdAt : null;
  const cursorId = typeof cursorValue?.id === 'string' ? cursorValue.id : null;

  const conditions = [eq(schema.applications.userId, userId)];
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

  const rows = await db
    .select()
    .from(schema.applications)
    .where(and(...conditions))
    .orderBy(desc(schema.applications.createdAt), desc(schema.applications.applicationId))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const items = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.applicationId }) : null,
  };
}

export interface AppendEventInput {
  applicationId: string;
  fromStatus: ApplicationStatus;
  toStatus: ApplicationStatus;
  note: string | null;
}

/** Folds the new status onto `applications` and appends the trail row in one transaction. */
export async function appendEvent(db: Database, input: AppendEventInput): Promise<ApplicationRow> {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const [updated] = await tx
      .update(schema.applications)
      .set({
        status: input.toStatus,
        lastEventAt: now,
        submittedAt: input.toStatus === 'submitted' ? now : undefined,
      })
      .where(eq(schema.applications.applicationId, input.applicationId))
      .returning();
    if (!updated) throw new Error('appendEvent: application disappeared mid-transaction');

    await tx.insert(schema.applicationEvents).values({
      applicationId: input.applicationId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      note: input.note,
    });

    return updated;
  });
}
