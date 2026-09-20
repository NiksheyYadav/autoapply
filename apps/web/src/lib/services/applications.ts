import type { ApplicationResponse, CreateApplicationRequest, ListApplicationsResponse } from '@atlas/types';
import { apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

export function createApplication(
  input: CreateApplicationRequest,
  idempotencyKey: string,
  accessToken: string,
): Promise<ApplicationResponse> {
  return apiFetch<ApplicationResponse>(SERVICE_URLS.applications, '/v1/applications', {
    method: 'POST',
    body: input,
    accessToken,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function listApplications(accessToken: string): Promise<ListApplicationsResponse> {
  return apiFetch<ListApplicationsResponse>(SERVICE_URLS.applications, '/v1/applications', { accessToken });
}
