import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { jobRecommendationsQuerySchema, type JobRecommendationsResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { isOrganizationMember, listForUser } from '../../repo/scores.js';

export function recommendationsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/jobs/recommendations', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const query = jobRecommendationsQuerySchema.parse(request.query);

    if (query.user_id !== actor.user_id) {
      // The query schema takes an arbitrary user_id; without this check
      // anyone could read anyone else's recommendations (IDOR). A role check
      // alone isn't enough either — an admin/owner token only lets them view
      // members of their *own* organization, not any user platform-wide.
      const isStaff = actor.role === 'admin' || actor.role === 'owner';
      const staffCanViewTarget = isStaff && (await isOrganizationMember(deps.db, actor.organization_id, query.user_id));
      if (!staffCanViewTarget) {
        throw new AppError('FORBIDDEN', "Cannot view another user's recommendations");
      }
    }

    const { items, nextCursor } = await listForUser(
      deps.db,
      query.user_id,
      { location: query.location, remoteType: query.remote_type },
      query,
    );
    const response: JobRecommendationsResponse = { items, next_cursor: nextCursor };
    reply.status(200).send(response);
  });
}
