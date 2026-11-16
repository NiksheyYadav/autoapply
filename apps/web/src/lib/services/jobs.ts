import type { Job, JobRecommendationsResponse } from '@atlas/types';
import { apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

export function getRecommendations(userId: string, accessToken: string, limit = 20): Promise<JobRecommendationsResponse> {
  const query = new URLSearchParams({ user_id: userId, limit: String(limit) });
  return apiFetch<JobRecommendationsResponse>(SERVICE_URLS.jobs, `/v1/jobs/recommendations?${query.toString()}`, {
    accessToken,
  });
}

export interface JobResponse {
  job: Job;
}

/**
 * One job by id. Responds 404 JOB_NOT_FOUND for an unknown id and 400 for a
 * malformed one; callers should treat both as "not available".
 *
 * Timestamps on the returned job (`posted_at` etc.) are not zod-parsed here:
 * read them with the lenient helper in components/applications/timestamp.
 */
export function getJob(jobId: string, accessToken: string): Promise<JobResponse> {
  return apiFetch<JobResponse>(SERVICE_URLS.jobs, `/v1/jobs/${encodeURIComponent(jobId)}`, { accessToken });
}
