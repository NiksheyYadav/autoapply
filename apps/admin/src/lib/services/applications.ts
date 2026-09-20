import type { ListApplicationsResponse } from '@atlas/types';
import { apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

export function listOrganizationApplications(accessToken: string): Promise<ListApplicationsResponse> {
  return apiFetch<ListApplicationsResponse>(SERVICE_URLS.applications, '/v1/applications?scope=organization', { accessToken });
}
