import type { FastifyReply, FastifyRequest } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import {
  ADMIN_ROSTER_ORG_TYPES,
  ADMIN_ROSTER_ROLES,
  adminOrgParamsSchema,
  type AdminRosterRole,
} from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../app.js';
import { findOrgMembership } from '../repo/membership.js';

/** Who the caller is *within the organization named in the URL*. */
export interface OrgScope {
  organizationId: string;
  userId: string;
  role: AdminRosterRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    orgScope?: OrgScope;
  }
}

function isRosterRole(role: string): role is AdminRosterRole {
  return (ADMIN_ROSTER_ROLES as readonly string[]).includes(role);
}

function isRosterOrgType(type: string): boolean {
  return (ADMIN_ROSTER_ORG_TYPES as readonly string[]).includes(type);
}

/**
 * `preParsing` hook for every `/v1/admin/organizations/:orgId/...` route. It
 * runs before the body is read, so an unauthenticated or unauthorized caller
 * never makes the service buffer and parse a large upload. It deliberately
 * runs after `onRequest`, where the rate limiter sits: throttling comes first.
 *
 *  1. 401 unless the bearer token verifies (`requireAuth`).
 *  2. 400 unless `:orgId` is a UUID.
 *  3. 404 unless the caller is a member of that organization. A non-member
 *     gets the same answer for an organization that does not exist and for one
 *     that does, so the API never confirms another tenant's ids.
 *  4. 403 for a member whose role is not owner/admin, or whose organization
 *     is not a university.
 *
 * Authorization comes from `organization_members`, not from the token's `org`
 * / `role` claims: the claims describe only the user's oldest membership and
 * lag behind revocations until the token expires.
 */
export function orgAdminGuard(deps: AppDeps) {
  const authenticate = requireAuth(deps.tokenVerifier);

  return async function orgAdminGuardHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await authenticate(request, reply);
    const actor = getActor(request);
    const { orgId } = adminOrgParamsSchema.parse(request.params);

    const membership = await findOrgMembership(deps.db, orgId, actor.user_id);
    if (!membership) {
      throw new AppError('NOT_FOUND', 'Organization not found');
    }
    if (!isRosterRole(membership.role)) {
      throw new AppError('FORBIDDEN', 'Only organization owners and admins can use this endpoint');
    }
    if (!isRosterOrgType(membership.organizationType)) {
      throw new AppError(
        'FORBIDDEN',
        'Roster management is only available for university organizations',
      );
    }

    request.orgScope = { organizationId: orgId, userId: actor.user_id, role: membership.role };
  };
}

/** The scope the guard attached. Throws if a route forgot to install the guard. */
export function getOrgScope(request: FastifyRequest): OrgScope {
  if (!request.orgScope) {
    throw new AppError('INTERNAL_ERROR', 'Request is missing its organization scope');
  }
  return request.orgScope;
}
