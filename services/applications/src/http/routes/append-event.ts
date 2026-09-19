import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { createEvent } from '@atlas/messaging';
import { appendApplicationEventRequestSchema, uuidSchema, type ApplicationResponse } from '@atlas/types';
import { AppError, newTraceContext } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { appendEvent, findById, toApplication } from '../../repo/applications.js';
import { isValidTransition } from '../../lib/transitions.js';

const paramsSchema = z.object({ id: uuidSchema });

export function appendEventRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/applications/:id/events', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const { id } = paramsSchema.parse(request.params);
    const body = appendApplicationEventRequestSchema.parse(request.body);

    const current = await findById(deps.db, id);
    const isOwner = current?.userId === actor.user_id;
    const isOrgStaff =
      current !== null &&
      (actor.role === 'admin' || actor.role === 'owner') &&
      current.organizationId !== null &&
      current.organizationId === actor.organization_id;

    if (!current || !(isOwner || isOrgStaff)) {
      throw new AppError('NOT_FOUND', 'Application not found');
    }

    if (!isValidTransition(current.status, body.to_status)) {
      throw new AppError('VALIDATION_ERROR', `Cannot move an application from "${current.status}" to "${body.to_status}"`);
    }

    const updated = await appendEvent(deps.db, {
      applicationId: id,
      fromStatus: current.status,
      toStatus: body.to_status,
      note: body.note ?? null,
    });

    if (body.to_status === 'submitted') {
      await deps.broker.publish(
        createEvent(
          'application.submitted',
          { application_id: updated.applicationId, user_id: updated.userId, job_id: updated.jobId, status: updated.status },
          newTraceContext({ organization_id: updated.organizationId, user_id: updated.userId }),
        ),
      );
    }

    const response: ApplicationResponse = { application: toApplication(updated) };
    reply.status(200).send(response);
  });
}
