import { apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

/** Mirrors analytics-service's SummaryResponse (services aren't packages, so this is redeclared, not imported). */
export interface SummaryResponse {
  organization_id: string;
  since: string;
  events: { event_type: string; count: number }[];
}

export function getSummary(accessToken: string, days = 30): Promise<SummaryResponse> {
  return apiFetch<SummaryResponse>(SERVICE_URLS.analytics, `/v1/analytics/summary?days=${days}`, { accessToken });
}
