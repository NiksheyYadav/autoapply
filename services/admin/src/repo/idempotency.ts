import { and, eq, lt } from 'drizzle-orm';
import { schema, type Database, type Transaction } from '@atlas/db';
import { AppError } from '@atlas/utils';

/** How long a stored response is replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface IdempotencyContext {
  /** Namespaces the key; include everything that must not share keys (org, caller). */
  scope: string;
  key: string;
  userId: string;
  /** Digest of the request, to tell a retry from a key reused for different input. */
  requestHash: string;
}

export interface IdempotentResult extends IdempotentResponse {
  replayed: boolean;
}

/**
 * Runs `work` at most once per (scope, key) using the `idempotency_keys`
 * table, and replays the stored response on a retry.
 *
 * The reservation, the work and the stored response commit in one transaction,
 * so there is no window where the work is done but the key is not recorded (or
 * the reverse). Two concurrent requests with the same key serialize on the
 * primary key: the second blocks on its INSERT until the first commits, then
 * finds the finished row and replays it. If the work throws, the reservation
 * rolls back with it and the client may retry with the same key.
 */
export async function runIdempotent(
  db: Database,
  context: IdempotencyContext,
  work: (tx: Transaction) => Promise<IdempotentResponse>,
): Promise<IdempotentResult> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const keys = schema.idempotencyKeys;

    // An expired key is a free slot, not a conflict.
    await tx
      .delete(keys)
      .where(
        and(
          eq(keys.scope, context.scope),
          eq(keys.key, context.key),
          lt(keys.expiresAt, now.toISOString()),
        ),
      );

    const reserved = await tx
      .insert(keys)
      .values({
        scope: context.scope,
        key: context.key,
        userId: context.userId,
        requestHash: context.requestHash,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      })
      .onConflictDoNothing()
      .returning({ key: keys.key });

    if (reserved.length === 0) {
      const [existing] = await tx
        .select()
        .from(keys)
        .where(and(eq(keys.scope, context.scope), eq(keys.key, context.key)))
        .limit(1);
      if (!existing) {
        throw new AppError(
          'CONFLICT',
          'The idempotency key is being used by another request; retry',
        );
      }
      if (existing.requestHash !== context.requestHash) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used for a different request',
        );
      }
      if (existing.responseStatus === null || existing.responseBody === null) {
        throw new AppError(
          'CONFLICT',
          'A request with this idempotency key is still in progress; retry',
        );
      }
      return { replayed: true, status: existing.responseStatus, body: existing.responseBody };
    }

    const response = await work(tx);
    await tx
      .update(keys)
      .set({ responseStatus: response.status, responseBody: response.body })
      .where(and(eq(keys.scope, context.scope), eq(keys.key, context.key)));
    return { replayed: false, ...response };
  });
}
