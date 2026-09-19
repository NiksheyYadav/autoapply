import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '@atlas/auth-kit';
import { paginationQuerySchema, remoteTypeSchema, type Job, type Page } from '@atlas/types';
import type { AppDeps } from '../../app.js';
import { listActive, toJob } from '../../repo/jobs.js';

const listJobsQuerySchema = paginationQuerySchema.extend({
  location: z.string().max(200).optional(),
  remote_type: remoteTypeSchema.optional(),
  is_active: z.stringbool().default(true),
});

export function listJobsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/jobs', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const query = listJobsQuerySchema.parse(request.query);
    const { items, nextCursor } = await listActive(
      deps.db,
      { location: query.location, remoteType: query.remote_type, isActive: query.is_active },
      query,
    );
    const response: Page<Job> = { items: items.map(toJob), next_cursor: nextCursor };
    reply.status(200).send(response);
  });
}
