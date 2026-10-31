import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { parseResumeText, scoreResume } from '@atlas/ai';
import { createEvent } from '@atlas/messaging';
import type { AtsReport, CreateResumeResponse, ParsedProfile } from '@atlas/types';
import { AppError, newTraceContext, pgErrorCode } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { extractText, resumeFailureReason, verifyResumeUpload } from '../../lib/extract-text.js';
import { sanitizeFilename } from '../../lib/filename.js';
import { sha256HexBuffer } from '../../lib/hash.js';
import { findByUserAndHash, insertPending, markFailed, markParsed } from '../../repo/resumes.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * The Zod contract for this endpoint (`createResumeRequestSchema`) only
 * describes the non-file field — the file itself is a multipart part, which
 * Zod doesn't validate.
 */
const sourceSchema = z.enum(['upload', 'connector', 'import']).default('upload');

export function uploadResumeRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post(
    '/v1/resumes',
    { preHandler: requireAuth(deps.tokenVerifier), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const actor = getActor(request);

      const data = await request.file();
      if (!data || data.fieldname !== 'file') {
        throw new AppError('VALIDATION_ERROR', 'Expected a multipart file field named "file"');
      }

      const sourceField = data.fields.source;
      const rawSource =
        sourceField && !Array.isArray(sourceField) && sourceField.type === 'field' ? sourceField.value : undefined;
      // Enforced for a well-formed request, even though it isn't persisted
      // yet — the `resumes` table has no `source` column.
      sourceSchema.parse(rawSource);

      const buffer = await data.toBuffer();
      // The multipart `Content-Type` is whatever the client claims. Check it
      // against the bytes (and bound DOCX archives) before anything is stored
      // or parsed; from here on only the canonical, verified type is used.
      const contentType = await verifyResumeUpload(buffer, data.mimetype);
      const contentHash = sha256HexBuffer(buffer);

      // Re-uploading the same bytes is a no-op: hand back the existing record
      // rather than storing a duplicate (docs/02, resumes_user_content_hash_key).
      const existing = await findByUserAndHash(deps.db, actor.user_id, contentHash);
      if (existing) {
        const response: CreateResumeResponse = { resume_id: existing.resumeId, status: existing.status };
        reply.status(200).send(response);
        return;
      }

      const storageKey = `resumes/${actor.user_id}/${contentHash}`;
      await deps.storage.put(storageKey, buffer, { contentType });

      let resumeId: string;
      try {
        const resume = await insertPending(deps.db, {
          userId: actor.user_id,
          storageUrl: storageKey,
          originalFilename: sanitizeFilename(data.filename),
          contentType,
          byteSize: buffer.length,
          contentHash,
        });
        resumeId = resume.resumeId;
      } catch (cause) {
        // Another request for the same user+bytes won the race between our
        // findByUserAndHash check and this insert — that's the same idempotent
        // case above, not a failure.
        if (pgErrorCode(cause) === UNIQUE_VIOLATION) {
          const raced = await findByUserAndHash(deps.db, actor.user_id, contentHash);
          if (raced) {
            const response: CreateResumeResponse = { resume_id: raced.resumeId, status: raced.status };
            reply.status(200).send(response);
            return;
          }
        }
        throw cause;
      }

      // Parsed synchronously — there's no worker yet, and a few hundred
      // milliseconds of heuristic parsing doesn't warrant queue infrastructure
      // this pass doesn't otherwise need.
      let parsed: { profile: ParsedProfile; report: AtsReport } | null = null;
      try {
        const text = await extractText(buffer, contentType);
        const profile = parseResumeText(text);
        const report = scoreResume(profile, text);
        await markParsed(deps.db, resumeId, {
          parsedText: text,
          parsedProfile: profile,
          atsScore: report.score,
          atsReport: report,
        });
        parsed = { profile, report };
      } catch (cause) {
        // `failure_reason` is returned to the client, and raw error text can
        // carry SQL plus bound parameters (i.e. the resume's own contents) or
        // parser internals. Persist a short stable reason; the detail goes to
        // the logs, where the logger's `err` serializer scrubs it.
        request.log.warn({ err: cause, resumeId }, 'resume parsing failed');
        await markFailed(deps.db, resumeId, resumeFailureReason(cause));
        const response: CreateResumeResponse = { resume_id: resumeId, status: 'failed' };
        reply.status(201).send(response);
        return;
      }

      // Parsing already succeeded and is persisted — a broker outage here is a
      // delivery problem, not a reason to tell the client the resume failed.
      try {
        await deps.broker.publish(
          createEvent(
            'resume.parsed',
            {
              resume_id: resumeId,
              user_id: actor.user_id,
              ats_score: parsed.report.score,
              skill_count: parsed.profile.skills.length,
              total_months_experience: parsed.profile.total_months_experience,
            },
            newTraceContext({ organization_id: actor.organization_id, user_id: actor.user_id }),
          ),
        );
      } catch (cause) {
        request.log.error({ err: cause, resumeId }, 'failed to publish resume.parsed event');
      }

      const response: CreateResumeResponse = { resume_id: resumeId, status: 'parsed' };
      reply.status(201).send(response);
    },
  );
}
