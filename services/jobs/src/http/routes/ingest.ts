import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth, requirePlatformAdmin } from '@atlas/auth-kit';
import { ingestJobsRequestSchema, type IngestionReport } from '@atlas/types';
import { newTraceContext } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { ingestPosting } from '../../lib/ingest-posting.js';

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
      try {
        const outcome = await ingestPosting(
          {
            db: deps.db,
            broker: deps.broker,
            newTrace: () => newTraceContext({ organization_id: actor.organization_id, user_id: actor.user_id }),
          },
          posting,
        );
        if (outcome.kind === 'inserted') report.inserted += 1;
        else report.duplicates += 1;
      } catch (cause) {
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
