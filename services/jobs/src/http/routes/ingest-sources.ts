import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isAuthorizedDrainRequest } from '@atlas/messaging';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { buildUserAgent } from '../../lib/job-sources/fetch-source.js';
import { DEFAULT_SOURCE_LIMIT, runSourceIngestion } from '../../lib/run-sources.js';

/**
 * Functions run with a 30s max duration (vercel.json). The budget is only
 * checked between boards and postings, so leave room for the one in flight
 * when it runs out.
 */
const DEFAULT_BUDGET_MS = 20_000;
const MAX_BUDGET_MS = 25_000;

/**
 * The service-scoped path: one Vercel project serves every service and
 * vercel.json rewrites by public path (`/internal/jobs/:path*` goes to the jobs
 * function), and the same app answers it when the jobs service is deployed on
 * its own or run locally.
 */
export const INGEST_SOURCES_PATH = '/internal/jobs/ingest-sources';

const ingestSourcesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(DEFAULT_SOURCE_LIMIT),
  budget_ms: z.coerce.number().int().min(100).max(MAX_BUDGET_MS).default(DEFAULT_BUDGET_MS),
  /** Run only this (enabled) source: to try a board straight after adding it. */
  source_id: z.uuid().optional(),
});

/**
 * `/internal/jobs/ingest-sources` reads the enabled job-board sources
 * (`job_sources`) and stores their postings. A scheduler triggers it with a GET
 * carrying `Authorization: Bearer $CRON_SECRET`; POST is accepted for manual
 * runs. Without a configured CRON_SECRET the route is disabled outright rather
 * than open, so a missing variable can never expose it.
 *
 * Registered outside the rate-limited scope on purpose, like the drain routes:
 * it is machine-authenticated and called on a schedule, and a throttled run
 * would silently stop the catalog from refreshing.
 */
export function ingestSourcesRoute(app: FastifyInstance, deps: AppDeps): void {
  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const secret = deps.env.CRON_SECRET;
    if (secret === undefined) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'Job source ingestion is not configured');
    }
    if (!isAuthorizedDrainRequest(request.headers.authorization, secret)) {
      reply.header('www-authenticate', 'Bearer');
      throw new AppError('UNAUTHENTICATED', 'Missing or invalid credentials');
    }

    const query = ingestSourcesQuerySchema.parse(request.query);
    const report = await runSourceIngestion(
      {
        db: deps.db,
        broker: deps.broker,
        logger: deps.logger,
        // Resolved per call, so a replaced global (tests) or injected client is honoured.
        fetch: deps.fetch ?? globalThis.fetch,
        userAgent: buildUserAgent(deps.env.JOB_SOURCE_CONTACT),
      },
      {
        budgetMs: query.budget_ms,
        limit: query.limit,
        ...(query.source_id === undefined ? {} : { sourceIds: [query.source_id] }),
      },
    );

    reply.status(200).send(report);
  };

  app.get(INGEST_SOURCES_PATH, handle);
  app.post(INGEST_SOURCES_PATH, handle);
}
