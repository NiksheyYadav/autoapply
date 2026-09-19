import type { FastifyInstance } from 'fastify';
import { requireAuth } from '@atlas/auth-kit';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findById, toJob } from '../../repo/jobs.js';

export function getJobRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/jobs/:id', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await findById(deps.db, id);
    if (!job) {
      throw new AppError('JOB_NOT_FOUND', 'Job not found');
    }
    reply.status(200).send({ job: toJob(job) });
  });
}
