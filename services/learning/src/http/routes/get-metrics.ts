import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth, requirePlatformAdmin } from '@atlas/auth-kit';
import type { AppDeps } from '../../app.js';
import { computeLearningMetrics } from '../../lib/metrics.js';
import { listApplicationPairs, listRecentScores } from '../../repo/lookups.js';

export interface LearningMetricsResponse {
  models: {
    model_version: string;
    applied_mean_score: number | null;
    not_applied_mean_score: number | null;
    applied_samples: number;
    not_applied_samples: number;
    lift: number | null;
  }[];
}

export function getMetricsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/learning/metrics', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    // Cross-tenant model-calibration aggregates (every user's scores and
    // applications), not one organization's data — so an org admin/owner role
    // is not enough (anyone can mint one by creating an org). Same
    // platform-admin allowlist as job ingestion.
    requirePlatformAdmin(actor, deps.env.PLATFORM_ADMIN_USER_IDS, 'Only platform administrators can view learning metrics');

    const [scores, appliedPairs] = await Promise.all([listRecentScores(deps.db), listApplicationPairs(deps.db)]);
    const metrics = computeLearningMetrics(scores, appliedPairs);

    const response: LearningMetricsResponse = {
      models: metrics.map((metric) => ({
        model_version: metric.modelVersion,
        applied_mean_score: metric.appliedMeanScore,
        not_applied_mean_score: metric.notAppliedMeanScore,
        applied_samples: metric.appliedSamples,
        not_applied_samples: metric.notAppliedSamples,
        lift: metric.lift,
      })),
    };
    reply.status(200).send(response);
  });
}
