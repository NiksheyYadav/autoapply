import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { MemberRole, OrganizationType } from '@atlas/types';

export interface OrgMembership {
  role: MemberRole;
  organizationType: OrganizationType;
}

/**
 * The caller's membership of one specific organization, read from the
 * database. Token claims are deliberately not used: the access token carries
 * only the user's *oldest* membership (custom_access_token_hook in
 * packages/db/supabase/auth-hooks.sql), and a revoked role must stop working
 * immediately rather than at token expiry.
 */
export async function findOrgMembership(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<OrgMembership | null> {
  const [row] = await db
    .select({ role: schema.organizationMembers.role, organizationType: schema.organizations.type })
    .from(schema.organizationMembers)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.organizationId, schema.organizationMembers.organizationId),
    )
    .where(
      and(
        eq(schema.organizationMembers.organizationId, organizationId),
        eq(schema.organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}
