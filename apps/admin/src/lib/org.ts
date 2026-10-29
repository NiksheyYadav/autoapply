import type { MemberRole } from '@atlas/types';
import { ADMIN_ROSTER_ROLES, uuidSchema } from './contracts';

/** Same check the API applies to `:orgId`, so a mistyped id is caught before a request is made. */
export function isOrganizationId(value: unknown): value is string {
  return typeof value === 'string' && uuidSchema.safeParse(value).success;
}

/** Roles the roster endpoints accept (owner, admin). The server decides; this only drives hints. */
export function isRosterRole(role: string | null | undefined): boolean {
  return role !== null && role !== undefined && (ADMIN_ROSTER_ROLES as readonly string[]).includes(role);
}

/** First block of a UUID: enough to tell two organizations apart on screen without the full id. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * What the sign-in itself says about the user's organization. `/v1/auth/me`
 * echoes the access token's `org_id` / `role` claims, and the token carries
 * only the user's *oldest* membership (custom_access_token_hook), so this is
 * at most one organization, and its role may lag behind the database. It is a
 * starting point for navigation, never an authorization decision: the admin
 * API re-checks the real membership on every request.
 */
export interface SessionOrganizationClaim {
  organizationId: string | null;
  role: MemberRole | null;
}

export interface OrganizationCandidate {
  organizationId: string;
  /** The role the sign-in claims for this organization. */
  claimedRole: MemberRole | null;
  /** The claimed role is one the roster endpoints accept. */
  claimsRosterAccess: boolean;
}

export function candidateOrganizations(claim: SessionOrganizationClaim): OrganizationCandidate[] {
  if (!claim.organizationId || !isOrganizationId(claim.organizationId)) return [];
  return [
    {
      organizationId: claim.organizationId,
      claimedRole: claim.role,
      claimsRosterAccess: isRosterRole(claim.role),
    },
  ];
}

export type Landing = { kind: 'open'; organizationId: string } | { kind: 'choose' };

/** Where `/dashboard` sends someone: straight into their organization when the sign-in names one with a roster role, else to the chooser. */
export function resolveLanding(claim: SessionOrganizationClaim): Landing {
  const [candidate] = candidateOrganizations(claim);
  if (candidate?.claimsRosterAccess) {
    return { kind: 'open', organizationId: candidate.organizationId };
  }
  return { kind: 'choose' };
}

/** Accepts a pasted id (surrounding spaces, any case) and returns the canonical form, or null. */
export function parseOrganizationIdInput(input: string): string | null {
  const candidate = input.trim().toLowerCase();
  return isOrganizationId(candidate) ? candidate : null;
}
