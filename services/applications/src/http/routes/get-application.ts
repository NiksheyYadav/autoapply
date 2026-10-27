import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { uuidSchema, type ApplicationResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findByIdWithJob, toApplication, toApplicationWithJob } from '../../repo/applications.js';

const paramsSchema = z.object({ id: uuidSchema });

export function getApplicationRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/applications/:id', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { id } = paramsSchema.parse(request.params);

    const found = await findByIdWithJob(deps.db, id);
    const isOwner = found?.application.userId === actor.user_id;
    const isOrgStaff =
      found !== null &&
      (actor.role === 'admin' || actor.role === 'owner') &&
      found.application.organizationId !== null &&
      found.application.organizationId === actor.organization_id;

    // 404, not 403: this endpoint never confirms that an application exists
    // for a job/user combination the caller isn't entitled to see.
    if (!found || !(isOwner || isOrgStaff)) {
      throw new AppError('NOT_FOUND', 'Application not found');
    }

    // The owner gets the job context. Org staff who are not the owner get the
    // plain application — no job or employer fields (see list-applications).
    const response: ApplicationResponse = {
      application: isOwner ? toApplicationWithJob(found.application, found.job) : toApplication(found.application),
    };
    reply.status(200).send(response);
  });
}
