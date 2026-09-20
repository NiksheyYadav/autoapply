import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { summarizeForOrganization } from '../../repo/summary.js';

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export interface SummaryResponse {
  organization_id: string;
  since: string;
  events: { event_type: string; count: number }[];
}

export function getSummaryRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/analytics/summary', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    if (actor.role !== 'admin' && actor.role !== 'owner') {
      throw new AppError('FORBIDDEN', 'Only org admins/owners can view analytics');
    }
    if (!actor.organization_id) {
      throw new AppError('VALIDATION_ERROR', 'This account is not attached to an organization');
    }

    const query = querySchema.parse(request.query);
    const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000).toISOString();
    const rows = await summarizeForOrganization(deps.db, actor.organization_id, since);

    const response: SummaryResponse = {
      organization_id: actor.organization_id,
      since,
      events: rows.map((row) => ({ event_type: row.eventType, count: row.count })),
    };
    reply.status(200).send(response);
  });
}
