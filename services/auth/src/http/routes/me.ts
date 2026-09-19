import type { FastifyInstance } from 'fastify';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findUserById, toPublicUser } from '../../repo/users.js';
import { getActor, requireAuth } from '../request-context.js';

export function meRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/auth/me', { preHandler: requireAuth(deps) }, async (request, reply) => {
    const actor = getActor(request);
    const user = await findUserById(deps.db, actor.user_id);
    if (!user) {
      throw new AppError('USER_NOT_FOUND', 'User no longer exists');
    }
    reply.status(200).send({
      user: toPublicUser(user),
      organization_id: actor.organization_id,
      role: actor.role,
      permissions: actor.permissions,
    });
  });
}
