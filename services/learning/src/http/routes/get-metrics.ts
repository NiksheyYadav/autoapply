import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { AppError } from '@atlas/utils';
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
    // Model-calibration internals, not user data — same admin/owner bar as
    // job ingestion, straight off the JWT claim (no DB round trip needed).
    if (actor.role !== 'admin' && actor.role !== 'owner') {
      throw new AppError('FORBIDDEN', 'Only org admins/owners can view learning metrics');
    }

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
