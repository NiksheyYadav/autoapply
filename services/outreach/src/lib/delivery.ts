import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@atlas/utils';
import type { OutreachServiceEnv } from '../env.js';

/**
 * Stable, machine-readable reason a delivery route was refused. Clients can
 * branch on it instead of parsing the message.
 */
export const DELIVERY_DISABLED_REASON = 'delivery_disabled';

/**
 * Guard for every route that would have Atlas deliver a message (`send`) or
 * promise to (`schedule`). It runs as a `preHandler` after `requireAuth`, so an
 * anonymous caller still gets a 401 and learns nothing, but before the handler
 * reads a parameter, reads the database, claims a row, calls the transport or
 * publishes an event.
 *
 * UPSTREAM_UNAVAILABLE (503) is the closest existing code: delivery is a
 * capability this deployment does not have, not something the caller did wrong.
 */
export function requireDeliveryEnabled(env: Pick<OutreachServiceEnv, 'OUTREACH_DELIVERY_ENABLED'>) {
  return async function requireDeliveryEnabledPreHandler(_request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (env.OUTREACH_DELIVERY_ENABLED) return;
    throw new AppError(
      'UPSTREAM_UNAVAILABLE',
      'Atlas does not deliver messages yet. Copy the draft or open it in your own email app, then record it with POST /v1/messages/:id/mark-sent.',
      { details: { reason: DELIVERY_DISABLED_REASON, alternative: 'POST /v1/messages/:id/mark-sent' } },
    );
  };
}
