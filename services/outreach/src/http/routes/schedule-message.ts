import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { scheduleMessageRequestSchema, uuidSchema, type MessageResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findById, setScheduled, toMessage } from '../../repo/messages.js';

const paramsSchema = z.object({ id: uuidSchema });

export function scheduleMessageRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/messages/:id/schedule', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { id } = paramsSchema.parse(request.params);
    const body = scheduleMessageRequestSchema.parse(request.body);

    const row = await findById(deps.db, id);
    if (!row || row.userId !== actor.user_id) {
      throw new AppError('NOT_FOUND', 'Message not found');
    }
    if (row.status !== 'draft') {
      throw new AppError('VALIDATION_ERROR', `Cannot schedule a message that is already "${row.status}"`);
    }
    if (new Date(body.scheduled_for).getTime() <= Date.now()) {
      throw new AppError('VALIDATION_ERROR', 'scheduled_for must be in the future');
    }

    const updated = await setScheduled(deps.db, id, body.scheduled_for);
    const response: MessageResponse = { message: toMessage(updated) };
    reply.status(200).send(response);
  });
}
