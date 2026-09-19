import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app.js';
import { writeAuditLog } from '../../repo/audit.js';
import { revokeSession } from '../../repo/sessions.js';
import { getActor, requireAuth } from '../request-context.js';

export function logoutRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/auth/logout', { preHandler: requireAuth(deps) }, async (request, reply) => {
    const actor = getActor(request);
    await revokeSession(deps.db, actor.session_id);
    await writeAuditLog(deps.db, {
      organizationId: actor.organization_id,
      actorUserId: actor.user_id,
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: actor.session_id,
      traceId: request.id,
    });
    reply.status(204).send();
  });
}
