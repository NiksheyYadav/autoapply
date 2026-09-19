import { and, asc, eq } from 'drizzle-orm';
import { schema, type Queryable } from '@atlas/db';
import type { Permissions } from '@atlas/types';

type MembershipRow = typeof schema.organizationMembers.$inferSelect;

export async function getMembership(
  db: Queryable,
  userId: string,
  organizationId: string | null,
): Promise<MembershipRow | null> {
  if (!organizationId) return null;
  const [membership] = await db
    .select()
    .from(schema.organizationMembers)
    .where(
      and(
        eq(schema.organizationMembers.userId, userId),
        eq(schema.organizationMembers.organizationId, organizationId),
      ),
    )
    .limit(1);
  return membership ?? null;
}

export async function getMembershipPermissions(
  db: Queryable,
  userId: string,
  organizationId: string | null,
): Promise<Permissions> {
  const membership = await getMembership(db, userId, organizationId);
  return membership?.permissions ?? {};
}

/** The org a freshly logged-in user is scoped to, absent an explicit "switch org" flow. */
export async function getPrimaryMembership(db: Queryable, userId: string): Promise<MembershipRow | null> {
  const [membership] = await db
    .select()
    .from(schema.organizationMembers)
    .where(eq(schema.organizationMembers.userId, userId))
    .orderBy(asc(schema.organizationMembers.createdAt))
    .limit(1);
  return membership ?? null;
}
