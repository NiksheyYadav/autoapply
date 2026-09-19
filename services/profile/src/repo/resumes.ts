import { and, desc, eq, lt } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { AtsReport, PaginationQuery, ParsedProfile, Resume } from '@atlas/types';
import { decodeCursor, encodeCursor } from '@atlas/utils';

type ResumeRow = typeof schema.resumes.$inferSelect;

export function toResume(row: ResumeRow): Resume {
  return {
    resume_id: row.resumeId,
    user_id: row.userId,
    storage_url: row.storageUrl,
    original_filename: row.originalFilename,
    content_type: row.contentType,
    byte_size: row.byteSize,
    status: row.status,
    parsed_text: row.parsedText,
    parsed_profile: row.parsedProfile ?? null,
    ats_score: row.atsScore,
    // No standalone embeddings table exists yet, so this can only signal
    // whether one was computed — not resolve to anything. Revisit once
    // embeddings are actually stored somewhere lookup-able by id.
    embedding_id: row.embedding ? row.resumeId : null,
    failure_reason: row.failureReason,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function findById(db: Database, resumeId: string): Promise<ResumeRow | null> {
  const [row] = await db.select().from(schema.resumes).where(eq(schema.resumes.resumeId, resumeId)).limit(1);
  return row ?? null;
}

export async function findByUserAndHash(
  db: Database,
  userId: string,
  contentHash: string,
): Promise<ResumeRow | null> {
  const [row] = await db
    .select()
    .from(schema.resumes)
    .where(and(eq(schema.resumes.userId, userId), eq(schema.resumes.contentHash, contentHash)))
    .limit(1);
  return row ?? null;
}

export interface InsertPendingInput {
  userId: string;
  storageUrl: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  contentHash: string;
}

export async function insertPending(db: Database, input: InsertPendingInput): Promise<ResumeRow> {
  const [row] = await db
    .insert(schema.resumes)
    .values({ ...input, status: 'pending' })
    .returning();
  if (!row) throw new Error('insertPending: insert returned no row');
  return row;
}

export interface MarkParsedInput {
  parsedText: string;
  parsedProfile: ParsedProfile;
  atsScore: number;
  atsReport: AtsReport;
}

export async function markParsed(db: Database, resumeId: string, result: MarkParsedInput): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(schema.resumes)
    .set({
      status: 'parsed',
      parsedText: result.parsedText,
      parsedProfile: result.parsedProfile,
      atsScore: result.atsScore,
      atsReport: result.atsReport,
      parsedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.resumes.resumeId, resumeId));
}

export async function markFailed(db: Database, resumeId: string, reason: string): Promise<void> {
  await db
    .update(schema.resumes)
    .set({ status: 'failed', failureReason: reason, updatedAt: new Date().toISOString() })
    .where(eq(schema.resumes.resumeId, resumeId));
}

export interface ListForUserResult {
  items: ResumeRow[];
  nextCursor: string | null;
}

export async function listForUser(
  db: Database,
  userId: string,
  pagination: PaginationQuery,
): Promise<ListForUserResult> {
  const cursorValue = pagination.cursor ? decodeCursor(pagination.cursor) : null;
  const cursorCreatedAt = typeof cursorValue?.createdAt === 'string' ? cursorValue.createdAt : null;

  const conditions = [eq(schema.resumes.userId, userId)];
  if (cursorCreatedAt) conditions.push(lt(schema.resumes.createdAt, cursorCreatedAt));

  const rows = await db
    .select()
    .from(schema.resumes)
    .where(and(...conditions))
    .orderBy(desc(schema.resumes.createdAt))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const items = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt }) : null };
}
