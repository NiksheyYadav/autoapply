import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { createMessageRequestSchema, type MessageResponse } from '@atlas/types';
import { AppError, IDEMPOTENCY_HEADER } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { draftMessage } from '../../lib/drafter.js';
import { findByUserAndIdempotencyKey, insertMessage, toMessage } from '../../repo/messages.js';
import {
  findApplicationOwnedBy,
  findCandidateSummary,
  findCompanyName,
  findContactById,
  findJobById,
} from '../../repo/lookups.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

const idempotencyKeySchema = z.string().min(8).max(200);

export function createMessageRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/messages', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);

    // Required per docs/04 § Validation rules, same as application submission.
    const rawKey = request.headers[IDEMPOTENCY_HEADER];
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', `${IDEMPOTENCY_HEADER} header is required`);
    }
    const idempotencyKey = idempotencyKeySchema.parse(rawKey);

    const body = createMessageRequestSchema.parse(request.body);
    if (!body.application_id && !body.contact_id) {
      throw new AppError('VALIDATION_ERROR', 'At least one of application_id or contact_id is required');
    }

    const existing = await findByUserAndIdempotencyKey(deps.db, actor.user_id, idempotencyKey);
    if (existing) {
      const sameRequest = existing.applicationId === body.application_id && existing.contactId === body.contact_id;
      if (!sameRequest) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
      }
      const response: MessageResponse = { message: toMessage(existing) };
      reply.status(200).send(response);
      return;
    }

    let jobTitle: string | null = null;
    let companyName: string | null = null;
    if (body.application_id) {
      const application = await findApplicationOwnedBy(deps.db, body.application_id, actor.user_id);
      if (!application) {
        throw new AppError('NOT_FOUND', 'Application not found');
      }
      const job = await findJobById(deps.db, application.jobId);
      if (job) {
        jobTitle = job.title;
        companyName = await findCompanyName(deps.db, job.companyId);
      }
    }

    let contactName: string | null = null;
    let contactTitle: string | null = null;
    if (body.contact_id) {
      const contact = await findContactById(deps.db, body.contact_id);
      if (!contact) {
        throw new AppError('NOT_FOUND', 'Contact not found');
      }
      contactName = contact.fullName;
      contactTitle = contact.title;
    }

    const candidate = await findCandidateSummary(deps.db, actor.user_id);

    // Manual overrides win; anything left unset is auto-drafted from context.
    const draft = draftMessage({
      candidateName: candidate?.fullName ?? null,
      jobTitle,
      companyName,
      contactName,
      contactTitle,
      topSkills: candidate?.topSkills ?? [],
    });

    try {
      const created = await insertMessage(deps.db, {
        userId: actor.user_id,
        applicationId: body.application_id,
        contactId: body.contact_id,
        channel: body.channel,
        subject: body.subject ?? draft.subject,
        body: body.body ?? draft.body,
        idempotencyKey,
      });
      const response: MessageResponse = { message: toMessage(created) };
      reply.status(201).send(response);
    } catch (cause) {
      if ((cause as { code?: string }).code === UNIQUE_VIOLATION) {
        const raced = await findByUserAndIdempotencyKey(deps.db, actor.user_id, idempotencyKey);
        if (raced) {
          const response: MessageResponse = { message: toMessage(raced) };
          reply.status(200).send(response);
          return;
        }
      }
      throw cause;
    }
  });
}
