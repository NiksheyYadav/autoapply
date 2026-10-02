import { eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { PublicUser } from '@atlas/types';

type UserRow = typeof schema.users.$inferSelect;

export function toPublicUser(user: UserRow): PublicUser {
  return {
    user_id: user.userId,
    email: user.email,
    full_name: user.fullName,
    auth_provider: user.authProvider,
    email_verified: user.emailVerified,
    mfa_enabled: user.mfaEnabled,
    created_at: user.createdAt,
  };
}

export async function findUserById(db: Database, userId: string): Promise<UserRow | null> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.userId, userId)).limit(1);
  return user ?? null;
}
