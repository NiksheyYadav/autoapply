import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { parseResumeText, scoreResume } from '@atlas/ai';
import { createEvent } from '@atlas/messaging';
import type { CreateResumeResponse } from '@atlas/types';
import { AppError, newTraceContext } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { extractText } from '../../lib/extract-text.js';
import { sha256HexBuffer } from '../../lib/hash.js';
import { findByUserAndHash, insertPending, markFailed, markParsed } from '../../repo/resumes.js';

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
      if (!data) {
        throw new AppError('VALIDATION_ERROR', 'Expected a multipart file field named "file"');
      }

      const sourceField = data.fields.source;
      const rawSource =
        sourceField && !Array.isArray(sourceField) && sourceField.type === 'field' ? sourceField.value : undefined;
      // Enforced for a well-formed request, even though it isn't persisted
      // yet — the `resumes` table has no `source` column.
      sourceSchema.parse(rawSource);

      const buffer = await data.toBuffer();
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
      await deps.storage.put(storageKey, buffer, { contentType: data.mimetype });

      const resume = await insertPending(deps.db, {
        userId: actor.user_id,
        storageUrl: storageKey,
        originalFilename: data.filename,
        contentType: data.mimetype,
        byteSize: buffer.length,
        contentHash,
      });

      // Parsed synchronously — there's no worker yet, and a few hundred
      // milliseconds of heuristic parsing doesn't warrant queue infrastructure
      // this pass doesn't otherwise need.
      try {
        const text = await extractText(buffer, data.mimetype);
        const profile = parseResumeText(text);
        const report = scoreResume(profile, text);
        await markParsed(deps.db, resume.resumeId, {
          parsedText: text,
          parsedProfile: profile,
          atsScore: report.score,
          atsReport: report,
        });

        await deps.broker.publish(
          createEvent(
            'resume.parsed',
            {
              resume_id: resume.resumeId,
              user_id: actor.user_id,
              ats_score: report.score,
              skill_count: profile.skills.length,
              total_months_experience: profile.total_months_experience,
            },
            newTraceContext({ organization_id: actor.organization_id, user_id: actor.user_id }),
          ),
        );

        const response: CreateResumeResponse = { resume_id: resume.resumeId, status: 'parsed' };
        reply.status(201).send(response);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        await markFailed(deps.db, resume.resumeId, reason);
        const response: CreateResumeResponse = { resume_id: resume.resumeId, status: 'failed' };
        reply.status(201).send(response);
      }
    },
  );
}
