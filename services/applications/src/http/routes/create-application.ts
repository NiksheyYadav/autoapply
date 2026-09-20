import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { createEvent } from '@atlas/messaging';
import { createApplicationRequestSchema, type ApplicationResponse } from '@atlas/types';
import { AppError, IDEMPOTENCY_HEADER, newTraceContext } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findActiveJob, findParsedResumeOwnedBy } from '../../repo/lookups.js';
import { findByUserAndIdempotencyKey, findByUserAndJob, insertApplication, toApplication } from '../../repo/applications.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

const idempotencyKeySchema = z.string().min(8).max(200);

export function createApplicationRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/applications', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);

    // Required per docs/04 § Validation rules: a retried submission can never
    // double-apply. Read from a header (not the body) so it's transport-level
    // metadata, consistent with how Idempotency-Key is used elsewhere.
    const rawKey = request.headers[IDEMPOTENCY_HEADER];
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', `${IDEMPOTENCY_HEADER} header is required`);
    }
    const idempotencyKey = idempotencyKeySchema.parse(rawKey);

    const body = createApplicationRequestSchema.parse(request.body);

    const existingByKey = await findByUserAndIdempotencyKey(deps.db, actor.user_id, idempotencyKey);
    if (existingByKey) {
      const sameRequest =
        existingByKey.jobId === body.job_id && existingByKey.resumeId === body.resume_id && existingByKey.mode === body.mode;
      if (!sameRequest) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
      }
      const response: ApplicationResponse = { application: toApplication(existingByKey) };
      reply.status(200).send(response);
      return;
    }

    const job = await findActiveJob(deps.db, body.job_id);
    if (!job || !job.isActive) {
      throw new AppError('JOB_NOT_FOUND', 'Job is unavailable');
    }

    const resume = await findParsedResumeOwnedBy(deps.db, body.resume_id, actor.user_id);
    if (!resume) {
      throw new AppError('RESUME_NOT_FOUND', 'Resume not found or not yet parsed');
    }

    const existingForJob = await findByUserAndJob(deps.db, actor.user_id, body.job_id);
    if (existingForJob) {
      throw new AppError('CONFLICT', 'You already have an application for this job', {
        details: { existing_application_id: existingForJob.applicationId },
      });
    }

    try {
      const created = await insertApplication(deps.db, {
        userId: actor.user_id,
        jobId: body.job_id,
        resumeId: body.resume_id,
        organizationId: actor.organization_id,
        mode: body.mode,
        // `auto` has nothing manual left to do before it's eligible for
        // submission; everything else starts as an editable draft.
        status: body.mode === 'auto' ? 'queued' : 'draft',
        idempotencyKey,
      });

      await deps.broker.publish(
        createEvent(
          'application.created',
          { application_id: created.applicationId, user_id: actor.user_id, job_id: created.jobId, mode: created.mode },
          newTraceContext({ organization_id: actor.organization_id, user_id: actor.user_id }),
        ),
      );

      const response: ApplicationResponse = { application: toApplication(created) };
      reply.status(201).send(response);
    } catch (cause) {
      // Another request from the same user raced us between the checks above
      // and this insert. Resolve it the same way the checks would have.
      if ((cause as { code?: string }).code === UNIQUE_VIOLATION) {
        const racedByKey = await findByUserAndIdempotencyKey(deps.db, actor.user_id, idempotencyKey);
        if (racedByKey) {
          const response: ApplicationResponse = { application: toApplication(racedByKey) };
          reply.status(200).send(response);
          return;
        }
        const racedByJob = await findByUserAndJob(deps.db, actor.user_id, body.job_id);
        if (racedByJob) {
          throw new AppError('CONFLICT', 'You already have an application for this job', {
            details: { existing_application_id: racedByJob.applicationId },
          });
        }
      }
      throw cause;
    }
  });
}
