import { apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

/** Mirrors learning-service's LearningMetricsResponse (services aren't packages, so this is redeclared, not imported). */
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

/** Platform-operators only: learning-service answers 403 to everyone else. */
export function getMetrics(accessToken: string, signal?: AbortSignal): Promise<LearningMetricsResponse> {
  return apiFetch<LearningMetricsResponse>(SERVICE_URLS.learning, '/v1/learning/metrics', { accessToken, signal });
}
