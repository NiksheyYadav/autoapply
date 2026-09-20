import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { createEvent } from '@atlas/messaging';
import { uuidSchema, type MessageResponse } from '@atlas/types';
import { AppError, newTraceContext } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { claimForSending, findById, setFailed, toMessage } from '../../repo/messages.js';

const paramsSchema = z.object({ id: uuidSchema });

export function sendMessageRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/messages/:id/send', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { id } = paramsSchema.parse(request.params);

    const row = await findById(deps.db, id);
    if (!row || row.userId !== actor.user_id) {
      throw new AppError('NOT_FOUND', 'Message not found');
    }

    // Claim atomically *before* calling the external transport — a
    // conditional UPDATE, not a read-then-write — so a concurrent request or
    // a client retrying a slow first attempt can't both reach transport.send
    // for the same message. Only the request that wins the claim proceeds;
    // the other sees `null` and fails fast without sending anything.
    const claimed = await claimForSending(deps.db, id);
    if (!claimed) {
      throw new AppError('VALIDATION_ERROR', `Cannot send a message that is already "${row.status}"`);
    }

    try {
      await deps.transport.send(toMessage(claimed));
    } catch (cause) {
      await setFailed(deps.db, id);
      throw cause;
    }

    await deps.broker.publish(
      createEvent(
        'outreach.sent',
        { message_id: claimed.messageId, user_id: claimed.userId, contact_id: claimed.contactId, channel: claimed.channel },
        newTraceContext({ user_id: claimed.userId }),
      ),
    );

    const response: MessageResponse = { message: toMessage(claimed) };
    reply.status(200).send(response);
  });
}
