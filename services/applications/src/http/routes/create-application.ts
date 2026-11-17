import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { createEvent } from '@atlas/messaging';
import { createApplicationRequestSchema, type ApplicationJobSummary, type ApplicationResponse } from '@atlas/types';
import { AppError, IDEMPOTENCY_HEADER, newTraceContext, pgErrorCode } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findJobSummary, findParsedResumeOwnedBy } from '../../repo/lookups.js';
import {
  findByUserAndIdempotencyKey,
  findByUserAndJob,
  insertApplication,
  toApplicationWithJob,
  type ApplicationRow,
} from '../../repo/applications.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

const idempotencyKeySchema = z.string().min(8).max(200);

/**
 * What `mode` actually does today:
 *
 * - `manual` / `review`: the application starts as an editable `draft`. Nothing
 *   submits it for the user — they apply on the employer's site (the owner's
 *   response carries `job.apply_url`) and then record the outcome with
 *   POST /v1/applications/:id/events.
 * - `auto`: the row is inserted as `queued`, but NOTHING consumes `queued`
 *   applications — there is no submission worker, queue consumer or browser
 *   automation. An auto application would sit in `queued` forever while the UI
 *   implies it is being handled. So `auto` is refused with a 400 until a worker
 *   exists and APPLICATIONS_AUTO_MODE_ENABLED=true is set for this service.
 */
const AUTO_MODE_UNAVAILABLE_MESSAGE =
  'Mode "auto" cannot be used: automatic submission is not available yet. Use "manual" or "review" instead.';

/** True when `existing` was created by a request with this job, resume and mode. */
function isSameRequest(
  existing: ApplicationRow,
  body: { job_id: string; resume_id: string; mode: string },
): boolean {
  return existing.jobId === body.job_id && existing.resumeId === body.resume_id && existing.mode === body.mode;
}

export function createApplicationRoute(app: FastifyInstance, deps: AppDeps): void {
  /** The owner's view of `row`, with the job it points at (null if the job or its company is gone). */
  async function ownerView(row: ApplicationRow, knownJob?: ApplicationJobSummary | null): Promise<ApplicationResponse> {
    const job = knownJob === undefined ? await findJobSummary(deps.db, row.jobId) : knownJob;
    return { application: toApplicationWithJob(row, job) };
  }

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

    if (body.mode === 'auto' && !deps.env.APPLICATIONS_AUTO_MODE_ENABLED) {
      throw new AppError('VALIDATION_ERROR', AUTO_MODE_UNAVAILABLE_MESSAGE, {
        details: [{ path: 'mode', message: AUTO_MODE_UNAVAILABLE_MESSAGE }],
      });
    }

    const existingByKey = await findByUserAndIdempotencyKey(deps.db, actor.user_id, idempotencyKey);
    if (existingByKey) {
      if (!isSameRequest(existingByKey, body)) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
      }
      reply.status(200).send(await ownerView(existingByKey));
      return;
    }

    const job = await findJobSummary(deps.db, body.job_id);
    if (!job || !job.is_active) {
      throw new AppError('JOB_NOT_FOUND', 'Job is unavailable');
    }

    const resume = await findParsedResumeOwnedBy(deps.db, body.resume_id, actor.user_id);
    if (!resume) {
      throw new AppError('RESUME_NOT_FOUND', 'Resume not found or not yet parsed');
    }

    const existingForJob = await findByUserAndJob(deps.db, actor.user_id, body.job_id);
    if (existingForJob) {
      // The same request sent twice at once: the first one's row was not visible to the key lookup
      // above but is by now. That is a replay (200), not a second application (409).
      if (existingForJob.idempotencyKey === idempotencyKey && isSameRequest(existingForJob, body)) {
        reply.status(200).send(await ownerView(existingForJob));
        return;
      }
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
        // submission; everything else starts as an editable draft. Only
        // reachable with APPLICATIONS_AUTO_MODE_ENABLED — see the note above.
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

      reply.status(201).send(await ownerView(created, job));
    } catch (cause) {
      // Another request from the same user raced us between the checks above
      // and this insert. Resolve it the same way the checks would have.
      if (pgErrorCode(cause) === UNIQUE_VIOLATION) {
        const racedByKey = await findByUserAndIdempotencyKey(deps.db, actor.user_id, idempotencyKey);
        if (racedByKey) {
          reply.status(200).send(await ownerView(racedByKey));
          return;
        }
        const racedByJob = await findByUserAndJob(deps.db, actor.user_id, body.job_id);
        if (racedByJob && racedByJob.idempotencyKey === idempotencyKey && isSameRequest(racedByJob, body)) {
          reply.status(200).send(await ownerView(racedByJob));
          return;
        }
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
