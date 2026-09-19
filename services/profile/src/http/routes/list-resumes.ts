import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { paginationQuerySchema, type Page, type Resume } from '@atlas/types';
import type { AppDeps } from '../../app.js';
import { listForUser, toResume } from '../../repo/resumes.js';

export function listResumesRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/resumes', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const query = paginationQuerySchema.parse(request.query);

    const { items, nextCursor } = await listForUser(deps.db, actor.user_id, query);

    const response: Page<Resume> = { items: items.map(toResume), next_cursor: nextCursor };
    reply.status(200).send(response);
  });
}
