import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import type { ResumeResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findById, toResume } from '../../repo/resumes.js';

export function getResumeRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/resumes/:id', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { id } = request.params as { id: string };

    const resume = await findById(deps.db, id);
    // Not-found covers "doesn't exist" and "belongs to someone else" alike —
    // this endpoint never confirms another user's resume exists.
    if (!resume || resume.userId !== actor.user_id) {
      throw new AppError('RESUME_NOT_FOUND', 'Resume not found');
    }

    const response: ResumeResponse = { resume: toResume(resume) };
    reply.status(200).send(response);
  });
}
