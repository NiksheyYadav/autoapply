import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { createEvent, derivedEventId } from '@atlas/messaging';
import { markMessageSentRequestSchema, uuidSchema, type MessageResponse } from '@atlas/types';
import { AppError, newTraceContext } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { claimAsSentByOwner, findById, revertSentClaim, toMessage } from '../../repo/messages.js';

const paramsSchema = z.object({ id: uuidSchema });

/**
 * The user tells Atlas they sent this message themselves (they copied it, or
 * opened it in their own mail app). Atlas delivered nothing, which is why this
 * works whether or not `OUTREACH_DELIVERY_ENABLED` is on, and why it never
 * touches the transport.
 *
 * `messages` has no column to tell a self-reported send from one Atlas made, so
 * the row looks the same afterwards. While delivery is off (the only supported
 * production configuration) every `sent` row is self-reported; if delivery is
 * ever turned on, add a column before relying on the difference.
 */
export function markMessageSentRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/messages/:id/mark-sent', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { id } = paramsSchema.parse(request.params);
    // No body at all is fine; Fastify leaves `request.body` undefined then.
    const body = markMessageSentRequestSchema.parse(request.body ?? {});

    // Ownership and claim in one conditional UPDATE (see claimAsSentByOwner).
    const claimed = await claimAsSentByOwner(deps.db, id, actor.user_id);
    if (!claimed) {
      const row = await findById(deps.db, id);
      // 404, not 403: never confirm that a message exists for someone else's id.
      if (!row || row.userId !== actor.user_id) {
        throw new AppError('NOT_FOUND', 'Message not found');
      }
      if (row.status === 'sent') {
        // A retry, a double click, or a request that lost a race: it is already recorded, so
        // answer with the current state and emit nothing a second time.
        const response: MessageResponse = { message: toMessage(row) };
        reply.status(200).send(response);
        return;
      }
      throw new AppError('CONFLICT', `Cannot mark a message that is "${row.status}" as sent`);
    }

    try {
      await deps.broker.publish(
        createEvent(
          'outreach.sent',
          { message_id: claimed.messageId, user_id: claimed.userId, contact_id: claimed.contactId, channel: claimed.channel },
          newTraceContext({ user_id: claimed.userId }),
          undefined,
          // One event per message: if this publish landed but reported failure, the retry after the
          // revert below publishes the same event_id and the outbox/consumers drop the duplicate.
          derivedEventId(claimed.messageId, 'outreach.sent'),
        ),
      );
    } catch (cause) {
      try {
        await revertSentClaim(deps.db, claimed);
      } catch (revertCause) {
        request.log.error({ err: revertCause, messageId: claimed.messageId }, 'could not revert mark-sent after a publish failure');
      }
      throw cause;
    }

    // Ids and a flag only: the note is not stored or logged (it is user text).
    request.log.info({ messageId: claimed.messageId, noteProvided: body.note !== undefined && body.note !== '' }, 'message recorded as sent by its owner');
    const response: MessageResponse = { message: toMessage(claimed) };
    reply.status(200).send(response);
  });
}
