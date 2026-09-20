import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { PublicUser } from '@atlas/types';

type UserRow = typeof schema.users.$inferSelect;
type OrganizationRow = typeof schema.organizations.$inferSelect;

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

export async function findUserByEmail(db: Database, email: string): Promise<UserRow | null> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = lower(${email})`)
    .limit(1);
  return user ?? null;
}

export async function findUserById(db: Database, userId: string): Promise<UserRow | null> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.userId, userId)).limit(1);
  return user ?? null;
}

export interface RegisterUserInput {
  email: string;
  fullName: string;
  passwordHash: string;
  organizationName?: string;
}

export interface RegisterUserResult {
  user: UserRow;
  organization: OrganizationRow | null;
}

/**
 * Creates the user and, when requested, an organization with that user as
 * `owner` — atomically, so an interrupted request never leaves a user
 * without the org it was supposed to get (or a dangling org with no owner).
 */
export async function registerUser(db: Database, input: RegisterUserInput): Promise<RegisterUserResult> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({
        email: input.email,
        fullName: input.fullName,
        passwordHash: input.passwordHash,
        authProvider: 'password',
      })
      .returning();
    if (!user) throw new Error('registerUser: user insert returned no row');

    if (!input.organizationName) {
      return { user, organization: null };
    }

    const [organization] = await tx
      .insert(schema.organizations)
      .values({ name: input.organizationName })
      .returning();
    if (!organization) throw new Error('registerUser: organization insert returned no row');

    await tx.insert(schema.organizationMembers).values({
      organizationId: organization.organizationId,
      userId: user.userId,
      role: 'owner',
    });

    return { user, organization };
  });
}

export interface RegisterOAuthUserInput {
  email: string;
  fullName: string;
  provider: 'google' | 'microsoft';
}

/**
 * Creates a user with no local credential — the IdP already vouched for the
 * email (docs/09 § Data protection: `passwordHash` stays null for SSO users).
 * No organization is created; there's no way to collect one mid-redirect.
 */
export async function registerOAuthUser(db: Database, input: RegisterOAuthUserInput): Promise<UserRow> {
  const [user] = await db
    .insert(schema.users)
    .values({
      email: input.email,
      fullName: input.fullName,
      authProvider: input.provider,
      passwordHash: null,
      emailVerified: true,
    })
    .returning();
  if (!user) throw new Error('registerOAuthUser: insert returned no row');
  return user;
}

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;

/** Increments the failed-login counter and locks the account past the threshold (docs/09). */
export async function recordFailedLogin(db: Database, userId: string, currentFailedCount: number): Promise<void> {
  const nextCount = currentFailedCount + 1;
  const lockedUntil =
    nextCount >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString() : null;
  await db
    .update(schema.users)
    .set({ failedLoginCount: nextCount, lockedUntil, updatedAt: new Date().toISOString() })
    .where(eq(schema.users.userId, userId));
}

export async function recordSuccessfulLogin(db: Database, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(schema.users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now })
    .where(eq(schema.users.userId, userId));
}
