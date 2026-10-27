import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '@atlas/auth-kit';
import { uuidSchema } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findById, toJob } from '../../repo/jobs.js';

// A malformed id must be a 400 here, not reach Postgres as a uuid cast
// failure (22P02) and surface as a 500.
const paramsSchema = z.object({ id: uuidSchema });

export function getJobRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/jobs/:id', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const job = await findById(deps.db, id);
    if (!job) {
      throw new AppError('JOB_NOT_FOUND', 'Job not found');
    }
    reply.status(200).send({ job: toJob(job) });
  });
}
