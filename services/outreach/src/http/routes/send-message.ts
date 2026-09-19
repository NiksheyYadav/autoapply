import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { createEvent } from '@atlas/messaging';
import { uuidSchema, type MessageResponse } from '@atlas/types';
import { AppError, newTraceContext } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findById, setFailed, setSent, toMessage } from '../../repo/messages.js';

const paramsSchema = z.object({ id: uuidSchema });

export function sendMessageRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/messages/:id/send', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { id } = paramsSchema.parse(request.params);

    const row = await findById(deps.db, id);
    if (!row || row.userId !== actor.user_id) {
      throw new AppError('NOT_FOUND', 'Message not found');
    }
    if (row.status !== 'draft' && row.status !== 'scheduled') {
      throw new AppError('VALIDATION_ERROR', `Cannot send a message that is already "${row.status}"`);
    }

    try {
      await deps.transport.send(toMessage(row));
    } catch (cause) {
      await setFailed(deps.db, id);
      throw cause;
    }

    const updated = await setSent(deps.db, id);
    await deps.broker.publish(
      createEvent(
        'outreach.sent',
        { message_id: updated.messageId, user_id: updated.userId, contact_id: updated.contactId, channel: updated.channel },
        newTraceContext({ user_id: updated.userId }),
      ),
    );

    const response: MessageResponse = { message: toMessage(updated) };
    reply.status(200).send(response);
  });
}
