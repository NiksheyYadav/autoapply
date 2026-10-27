import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth, requirePlatformAdmin } from '@atlas/auth-kit';
import { extractSkillKeywords } from '@atlas/ai';
import { createEvent } from '@atlas/messaging';
import { ingestJobsRequestSchema, type IngestionReport } from '@atlas/types';
import { newTraceContext, pgErrorCode } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import {
  coerceEmploymentType,
  coerceRemoteType,
  computeJobHash,
  estimateSpamScore,
  normalizeApplyUrl,
  normalizeWebsiteUrl,
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
    // The jobs catalog is shared by every tenant, so writing to it is a
    // platform-level action. An org admin/owner role is not enough: anyone
    // can create an organization, so that role carries no platform trust.
    requirePlatformAdmin(actor, deps.env.PLATFORM_ADMIN_USER_IDS, 'Only platform administrators can ingest job postings');

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

    for (const [index, posting] of postings.entries()) {
      const remoteType = coerceRemoteType(posting.remote_type);
      const jobHash = computeJobHash(posting.company_name, posting.title, posting.location ?? null, remoteType);

      try {
        const company = await findOrCreateByName(
          deps.db,
          posting.company_name,
          normalizeWebsiteUrl(posting.company_website),
        );

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
        if (pgErrorCode(cause) === UNIQUE_VIOLATION) {
          const raced = await findByHash(deps.db, jobHash);
          if (raced) {
            await touchSeen(deps.db, raced.jobId);
            report.duplicates += 1;
            continue;
          }
        }
        report.rejected += 1;
        // Driver/ORM errors embed SQL and bound values (the whole posting) —
        // the detail stays in our logs, the caller only learns which item failed.
        request.log.error({ err: cause, posting_index: index }, 'failed to ingest job posting');
        report.errors.push(`postings[${index}]: could not be processed`);
      }
    }

    reply.status(200).send(report);
  });
}
