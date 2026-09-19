import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { listApplicationsQuerySchema, type ListApplicationsResponse } from '@atlas/types';
import type { AppDeps } from '../../app.js';
import { listForUser, toApplication } from '../../repo/applications.js';

export function listApplicationsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/applications', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const query = listApplicationsQuerySchema.parse(request.query);
    const { items, nextCursor } = await listForUser(deps.db, actor.user_id, query);
    const response: ListApplicationsResponse = { items: items.map(toApplication), next_cursor: nextCursor };
    reply.status(200).send(response);
  });
}
