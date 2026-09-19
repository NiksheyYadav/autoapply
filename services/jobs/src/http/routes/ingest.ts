import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { extractSkillKeywords } from '@atlas/ai';
import { createEvent } from '@atlas/messaging';
import { ingestJobsRequestSchema, type IngestionReport } from '@atlas/types';
import { AppError, newTraceContext } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import {
  coerceEmploymentType,
  coerceRemoteType,
  computeJobHash,
  estimateSpamScore,
  normalizeApplyUrl,
} from '../../lib/normalize.js';
import { findOrCreateByName } from '../../repo/companies.js';
import { findByHash, insert, touchSeen } from '../../repo/jobs.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

function parsePostedAt(raw?: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function ingestRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/jobs/ingest', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    // Straight off the JWT claim (set at login) — no DB round trip needed to check role.
    if (actor.role !== 'admin' && actor.role !== 'owner') {
      throw new AppError('FORBIDDEN', 'Only org admins/owners can ingest job postings');
    }

    const { postings } = ingestJobsRequestSchema.parse(request.body);
    const firstSource = postings[0]?.source ?? 'manual';
    const report: IngestionReport = {
      source: postings.every((p) => p.source === firstSource) ? firstSource : 'mixed',
      fetched: postings.length,
      inserted: 0,
      duplicates: 0,
      rejected: 0,
      errors: [],
    };

    for (const posting of postings) {
      const remoteType = coerceRemoteType(posting.remote_type);
      const jobHash = computeJobHash(posting.company_name, posting.title, posting.location ?? null, remoteType);

      try {
        const company = await findOrCreateByName(deps.db, posting.company_name, posting.company_website);

        const existing = await findByHash(deps.db, jobHash);
        if (existing) {
          await touchSeen(deps.db, existing.jobId);
          report.duplicates += 1;
          continue;
        }

        const job = await insert(deps.db, {
          companyId: company.companyId,
          title: posting.title,
          description: posting.description ?? null,
          salaryMin: posting.salary_min ?? null,
          salaryMax: posting.salary_max ?? null,
          salaryCurrency: posting.salary_currency ?? null,
          location: posting.location ?? null,
          remoteType,
          employmentType: coerceEmploymentType(posting.employment_type),
          source: posting.source,
          externalId: posting.external_id,
          applyUrl: normalizeApplyUrl(posting.apply_url),
          jobHash,
          skills: extractSkillKeywords(posting.description ?? ''),
          spamScore: estimateSpamScore(posting),
          postedAt: parsePostedAt(posting.posted_at),
        });

        await deps.broker.publish(
          createEvent(
            'job.discovered',
            { job_id: job.jobId, company_id: job.companyId, source: job.source, job_hash: job.jobHash, title: job.title },
            newTraceContext({ organization_id: actor.organization_id, user_id: actor.user_id }),
          ),
        );
        report.inserted += 1;
      } catch (cause) {
        // Another ingest request won the race to insert this exact job between
        // our findByHash check and our insert — that's a duplicate, not a failure.
        if ((cause as { code?: string }).code === UNIQUE_VIOLATION) {
          const raced = await findByHash(deps.db, jobHash);
          if (raced) {
            await touchSeen(deps.db, raced.jobId);
            report.duplicates += 1;
            continue;
          }
        }
        report.rejected += 1;
        report.errors.push(cause instanceof Error ? cause.message : String(cause));
      }
    }

    reply.status(200).send(report);
  });
}
