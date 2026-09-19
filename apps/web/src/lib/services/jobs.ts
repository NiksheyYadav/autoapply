import type { JobRecommendationsResponse } from '@atlas/types';
import { apiFetch } from '../api.js';
import { SERVICE_URLS } from '../config.js';

export function getRecommendations(userId: string, accessToken: string): Promise<JobRecommendationsResponse> {
  const query = new URLSearchParams({ user_id: userId, limit: '20' });
  return apiFetch<JobRecommendationsResponse>(SERVICE_URLS.jobs, `/v1/jobs/recommendations?${query.toString()}`, {
    accessToken,
  });
}
