import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { uuidSchema, type MessageResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findById, toMessage } from '../../repo/messages.js';

const paramsSchema = z.object({ id: uuidSchema });

export function getMessageRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/messages/:id', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { id } = paramsSchema.parse(request.params);
    const row = await findById(deps.db, id);
    // 404, not 403: never confirm that a message exists for someone else's id.
    if (!row || row.userId !== actor.user_id) {
      throw new AppError('NOT_FOUND', 'Message not found');
    }
    const response: MessageResponse = { message: toMessage(row) };
    reply.status(200).send(response);
  });
}
