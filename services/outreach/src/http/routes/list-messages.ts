import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { paginationQuerySchema, type ListMessagesResponse } from '@atlas/types';
import type { AppDeps } from '../../app.js';
import { listForUser, toMessage } from '../../repo/messages.js';

export function listMessagesRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/messages', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const query = paginationQuerySchema.parse(request.query);
    const { items, nextCursor } = await listForUser(deps.db, actor.user_id, query);
    const response: ListMessagesResponse = { items: items.map(toMessage), next_cursor: nextCursor };
    reply.status(200).send(response);
  });
}
