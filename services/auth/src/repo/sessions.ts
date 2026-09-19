import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database, type Queryable } from '@atlas/db';
import { newToken, sha256Hex } from '@atlas/utils';

type SessionRow = typeof schema.sessions.$inferSelect;

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
}

export interface CreateSessionInput {
  userId: string;
  organizationId: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  refreshTokenTtlSeconds: number;
}

/** Only the refresh token's SHA-256 is persisted — see docs/09 § Data protection. */
export async function createSession(db: Queryable, input: CreateSessionInput): Promise<IssuedSession> {
  const refreshToken = newToken(32);
  const expiresAt = new Date(Date.now() + input.refreshTokenTtlSeconds * 1000).toISOString();
  const [session] = await db
    .insert(schema.sessions)
    .values({
      userId: input.userId,
      organizationId: input.organizationId,
      refreshTokenHash: sha256Hex(refreshToken),
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      expiresAt,
    })
    .returning();
  if (!session) throw new Error('createSession: insert returned no row');
  return { sessionId: session.sessionId, refreshToken };
}

export async function findSessionByRefreshToken(db: Queryable, refreshToken: string): Promise<SessionRow | null> {
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.refreshTokenHash, sha256Hex(refreshToken)))
    .limit(1);
  return session ?? null;
}

export async function revokeSession(
  db: Queryable,
  sessionId: string,
  rotatedToSessionId?: string,
): Promise<void> {
  await db
    .update(schema.sessions)
    .set({
      revokedAt: new Date().toISOString(),
      ...(rotatedToSessionId ? { rotatedToSessionId } : {}),
    })
    .where(eq(schema.sessions.sessionId, sessionId));
}

/** Nuclear option for suspected token theft — see rotateSession's reuse check. */
export async function revokeAllUserSessions(db: Queryable, userId: string): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
}

/**
 * Rotates a refresh token: issues a replacement session and marks the
 * current one revoked-and-rotated in one transaction, so a crash between the
 * two steps can never leave both sessions simultaneously valid.
 */
export async function rotateSession(
  db: Database,
  current: Pick<SessionRow, 'sessionId' | 'userId' | 'organizationId' | 'userAgent' | 'ipAddress'>,
  refreshTokenTtlSeconds: number,
): Promise<IssuedSession> {
  return db.transaction(async (tx) => {
    const next = await createSession(tx, {
      userId: current.userId,
      organizationId: current.organizationId,
      userAgent: current.userAgent,
      ipAddress: current.ipAddress,
      refreshTokenTtlSeconds,
    });
    await revokeSession(tx, current.sessionId, next.sessionId);
    return next;
  });
}
