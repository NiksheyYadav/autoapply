import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isAuthorizedDrainRequest, isDrainableBroker } from '@atlas/messaging';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';

/**
 * Functions run with a 30s max duration (vercel.json). The budget is only
 * checked between deliveries, so leave room for a handler that is mid-flight
 * when it runs out.
 */
const DEFAULT_BUDGET_MS = 20_000;
const MAX_BUDGET_MS = 25_000;

/**
 * Every service shares one Vercel project, and vercel.json rewrites by public
 * path, so four services cannot all be reached at `/internal/drain`. The
 * service-scoped path is the one a rewrite can send to this function (and the
 * one its cron targets); `/internal/drain` is the same handler, for local runs
 * and manual triggers.
 */
const DRAIN_PATHS = ['/internal/drain', '/internal/referrals/drain'] as const;

const drainQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  budget_ms: z.coerce.number().int().min(100).max(MAX_BUDGET_MS).optional(),
});

/**
 * `/internal/drain` runs this service's queued event deliveries (see the
 * `postgres` messaging driver). Vercel Cron triggers it with a GET carrying
 * `Authorization: Bearer $CRON_SECRET`; POST is accepted for manual runs.
 * Without a configured CRON_SECRET the route is disabled outright rather than
 * open, so a missing variable can never expose it.
 */
export function drainRoute(app: FastifyInstance, deps: AppDeps): void {
  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const secret = deps.env.CRON_SECRET;
    if (secret === undefined) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'Event draining is not configured');
    }
    if (!isAuthorizedDrainRequest(request.headers.authorization, secret)) {
      reply.header('www-authenticate', 'Bearer');
      throw new AppError('UNAUTHENTICATED', 'Missing or invalid drain credentials');
    }
    if (!isDrainableBroker(deps.broker)) {
      throw new AppError('CONFLICT', 'The configured messaging driver has nothing to drain');
    }

    const query = drainQuerySchema.parse(request.query);
    const startedAt = Date.now();
    const result = await deps.broker.drain({
      budgetMs: query.budget_ms ?? DEFAULT_BUDGET_MS,
      limit: query.limit,
    });
    const durationMs = Date.now() - startedAt;

    request.log.info({ ...result, duration_ms: durationMs }, 'drained queued events');
    reply.status(200).send({ ...result, duration_ms: durationMs });
  };

  for (const path of DRAIN_PATHS) {
    app.get(path, handle);
    app.post(path, handle);
  }
}
