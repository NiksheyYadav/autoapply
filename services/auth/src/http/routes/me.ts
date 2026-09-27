import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { getMembershipPermissions } from '../../repo/organizations.js';
import { findUserById, toPublicUser } from '../../repo/users.js';

/**
 * The one auth-kit consumer that still needs a DB round trip: permissions are
 * a mutable jsonb blob that can change faster than a token's TTL, so they're
 * looked up here rather than trusted from the JWT (unlike org_id/role, which
 * the Supabase custom_access_token_hook already stamps in).
 */
export function meRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/auth/me', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const user = await findUserById(deps.db, actor.user_id);
    if (!user) {
      throw new AppError('USER_NOT_FOUND', 'User no longer exists');
    }
    const permissions = await getMembershipPermissions(deps.db, actor.user_id, actor.organization_id);
    reply.status(200).send({
      user: toPublicUser(user),
      organization_id: actor.organization_id,
      role: actor.role,
      permissions,
    });
  });
}
