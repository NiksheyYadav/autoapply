import { and, desc, eq, lt, or } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Message, MessageChannel, PaginationQuery } from '@atlas/types';
import { decodeCursor, encodeCursor } from '@atlas/utils';

type MessageRow = typeof schema.messages.$inferSelect;

export function toMessage(row: MessageRow): Message {
  return {
    message_id: row.messageId,
    application_id: row.applicationId,
    contact_id: row.contactId,
    user_id: row.userId,
    channel: row.channel,
    status: row.status,
    subject: row.subject,
    body: row.body,
    idempotency_key: row.idempotencyKey,
    scheduled_for: row.scheduledFor,
    sent_at: row.sentAt,
    created_at: row.createdAt,
  };
}

export async function findById(db: Database, messageId: string): Promise<MessageRow | null> {
  const [row] = await db.select().from(schema.messages).where(eq(schema.messages.messageId, messageId)).limit(1);
  return row ?? null;
}

export async function findByUserAndIdempotencyKey(
  db: Database,
  userId: string,
  idempotencyKey: string,
): Promise<MessageRow | null> {
  const [row] = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.userId, userId), eq(schema.messages.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row ?? null;
}

export interface InsertMessageInput {
  userId: string;
  applicationId: string | null;
  contactId: string | null;
  channel: MessageChannel;
  subject: string | null;
  body: string;
  idempotencyKey: string;
}

export async function insertMessage(db: Database, input: InsertMessageInput): Promise<MessageRow> {
  const [row] = await db.insert(schema.messages).values({ ...input, status: 'draft' }).returning();
  if (!row) throw new Error('insertMessage: insert returned no row');
  return row;
}

export async function setScheduled(db: Database, messageId: string, scheduledFor: string): Promise<MessageRow> {
  const [row] = await db
    .update(schema.messages)
    .set({ status: 'scheduled', scheduledFor })
    .where(eq(schema.messages.messageId, messageId))
    .returning();
  if (!row) throw new Error('setScheduled: message disappeared mid-update');
  return row;
}

export async function setSent(db: Database, messageId: string): Promise<MessageRow> {
  const [row] = await db
    .update(schema.messages)
    .set({ status: 'sent', sentAt: new Date().toISOString() })
    .where(eq(schema.messages.messageId, messageId))
    .returning();
  if (!row) throw new Error('setSent: message disappeared mid-update');
  return row;
}

export async function setFailed(db: Database, messageId: string): Promise<MessageRow> {
  const [row] = await db
    .update(schema.messages)
    .set({ status: 'failed' })
    .where(eq(schema.messages.messageId, messageId))
    .returning();
  if (!row) throw new Error('setFailed: message disappeared mid-update');
  return row;
}

export interface ListForUserResult {
  items: MessageRow[];
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

  const conditions = [eq(schema.messages.userId, userId)];
  if (cursorCreatedAt && cursorId) {
    const tieBreak = or(
      lt(schema.messages.createdAt, cursorCreatedAt),
      and(eq(schema.messages.createdAt, cursorCreatedAt), lt(schema.messages.messageId, cursorId)),
    );
    if (tieBreak) conditions.push(tieBreak);
  }

  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(...conditions))
    .orderBy(desc(schema.messages.createdAt), desc(schema.messages.messageId))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const items = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.messageId }) : null,
  };
}
