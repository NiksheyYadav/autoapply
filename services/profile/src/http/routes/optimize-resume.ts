import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { analyzeResumeForJob } from '@atlas/ai';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { optimizeResumeRequestSchema, uuidSchema, type OptimizeResumeResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findOptimizationTarget } from '../../repo/jobs.js';
import { findById } from '../../repo/resumes.js';

const paramsSchema = z.object({ id: uuidSchema });

/**
 * Stateless: computes advice on every call and stores nothing, so there is no
 * migration and no stale-report problem. Persisting tailored variants waits
 * on a rewriting step that doesn't exist yet (see analyzeResumeForJob).
 */
export function optimizeResumeRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/resumes/:id/optimize', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { id } = paramsSchema.parse(request.params);
    const body = optimizeResumeRequestSchema.parse(request.body);

    const resume = await findById(deps.db, id);
    // Same rule as GET /v1/resumes/:id: never confirm another user's resume exists.
    if (!resume || resume.userId !== actor.user_id) {
      throw new AppError('RESUME_NOT_FOUND', 'Resume not found');
    }
    if (resume.status !== 'parsed' || !resume.parsedProfile || resume.parsedText === null) {
      throw new AppError('CONFLICT', 'Resume has not been parsed successfully, so it cannot be optimized yet');
    }

    const target = await findOptimizationTarget(deps.db, body.job_id);
    if (!target) {
      throw new AppError('JOB_NOT_FOUND', 'Job is unavailable');
    }

    const response: OptimizeResumeResponse = {
      resume_id: resume.resumeId,
      job_id: body.job_id,
      report: analyzeResumeForJob(resume.parsedProfile, resume.parsedText, target),
    };
    reply.status(200).send(response);
  });
}
