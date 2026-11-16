import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
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

/**
 * Atomically claims a message for sending by flipping it straight to `sent`
 * *before* the external transport call, guarded by the status check in the
 * `WHERE` clause. Two concurrent requests (a real race, or a client retrying
 * a slow first attempt) can't both pass this: only one UPDATE matches a row,
 * the other gets `null` back and must not call the transport. If the send
 * itself then fails, the caller reverts the claim via `setFailed`.
 */
const CLAIMABLE_STATUSES = ['draft', 'scheduled', 'failed'] as const;

export async function claimForSending(db: Database, messageId: string): Promise<MessageRow | null> {
  const [row] = await db
    .update(schema.messages)
    .set({ status: 'sent', sentAt: new Date().toISOString() })
    .where(and(eq(schema.messages.messageId, messageId), inArray(schema.messages.status, CLAIMABLE_STATUSES)))
    .returning();
  return row ?? null;
}

/**
 * Atomically records that the message's owner sent it themselves. The owner and
 * status checks are in the `WHERE` clause, so ownership and the claim are one
 * statement: a message that is another user's, missing, or no longer
 * draft/scheduled matches nothing and comes back `null`, and of any number of
 * concurrent callers exactly one gets the row (and so publishes the event).
 */
const SELF_REPORTABLE_STATUSES = ['draft', 'scheduled'] as const;

export async function claimAsSentByOwner(
  db: Database,
  messageId: string,
  userId: string,
): Promise<MessageRow | null> {
  const [row] = await db
    .update(schema.messages)
    .set({ status: 'sent', sentAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.messages.messageId, messageId),
        eq(schema.messages.userId, userId),
        inArray(schema.messages.status, SELF_REPORTABLE_STATUSES),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Undoes `claimAsSentByOwner` when the event could not be published, so a retry
 * starts from a clean state instead of finding a `sent` message whose event was
 * never emitted. Only a row still holding the claim's own `sent_at` is touched.
 * `scheduled_for` is set exactly when the message was scheduled, which is how
 * the earlier status is recovered.
 */
export async function revertSentClaim(db: Database, claimed: MessageRow): Promise<void> {
  if (claimed.sentAt === null) return;
  await db
    .update(schema.messages)
    .set({ status: claimed.scheduledFor === null ? 'draft' : 'scheduled', sentAt: null })
    .where(
      and(
        eq(schema.messages.messageId, claimed.messageId),
        eq(schema.messages.status, 'sent'),
        eq(schema.messages.sentAt, claimed.sentAt),
      ),
    );
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
