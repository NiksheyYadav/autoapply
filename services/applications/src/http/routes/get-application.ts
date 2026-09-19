import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { uuidSchema, type ApplicationResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findById, toApplication } from '../../repo/applications.js';

const paramsSchema = z.object({ id: uuidSchema });

export function getApplicationRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/applications/:id', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { id } = paramsSchema.parse(request.params);

    const row = await findById(deps.db, id);
    const isOwner = row?.userId === actor.user_id;
    const isOrgStaff =
      row !== null &&
      (actor.role === 'admin' || actor.role === 'owner') &&
      row.organizationId !== null &&
      row.organizationId === actor.organization_id;

    // 404, not 403: this endpoint never confirms that an application exists
    // for a job/user combination the caller isn't entitled to see.
    if (!row || !(isOwner || isOrgStaff)) {
      throw new AppError('NOT_FOUND', 'Application not found');
    }

    const response: ApplicationResponse = { application: toApplication(row) };
    reply.status(200).send(response);
  });
}
