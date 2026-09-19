import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { jobRecommendationsQuerySchema, type JobRecommendationsResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { listForUser } from '../../repo/scores.js';

export function recommendationsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/jobs/recommendations', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const query = jobRecommendationsQuerySchema.parse(request.query);

    // The query schema takes an arbitrary user_id; without this check anyone
    // could read anyone else's recommendations (IDOR).
    const canViewOthers = actor.role === 'admin' || actor.role === 'owner';
    if (query.user_id !== actor.user_id && !canViewOthers) {
      throw new AppError('FORBIDDEN', "Cannot view another user's recommendations");
    }

    const { items, nextCursor } = await listForUser(deps.db, query.user_id, query);
    const response: JobRecommendationsResponse = { items, next_cursor: nextCursor };
    reply.status(200).send(response);
  });
}
