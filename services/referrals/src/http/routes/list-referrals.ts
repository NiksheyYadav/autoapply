import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import type { ListReferralsResponse } from '@atlas/types';
import type { AppDeps } from '../../app.js';
import { findReferralCandidatesForUser } from '../../lib/candidates.js';

export function listReferralsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/referrals', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const items = await findReferralCandidatesForUser(deps.db, actor.user_id);
    const response: ListReferralsResponse = { items };
    reply.status(200).send(response);
  });
}
