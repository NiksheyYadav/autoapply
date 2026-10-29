import type {
  AppendApplicationEventRequest,
  ApplicationResponse,
  CreateApplicationRequest,
  ListApplicationsResponse,
} from '@atlas/types';
import { apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

/**
 * Responses from this service are deliberately NOT run through the strict zod
 * schemas: its timestamps are Postgres-style strings (`2026-10-27
 * 12:59:21.123+00`) that `isoTimestampSchema` rejects. Read them with
 * components/applications/timestamp instead.
 */

/**
 * Creates an application. Only `mode: 'manual'` is usable today: the service
 * rejects `auto` with a 400 (Atlas cannot submit to an employer's ATS on a
 * candidate's behalf), so this client never sends it.
 *
 * Idempotent per user: repeating the same (job, resume, mode) with the same
 * key returns the existing application (200) instead of creating another.
 */
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

export interface ListApplicationsOptions {
  limit?: number;
  cursor?: string | null;
}

export function listApplications(accessToken: string, options: ListApplicationsOptions = {}): Promise<ListApplicationsResponse> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.cursor) query.set('cursor', options.cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch<ListApplicationsResponse>(SERVICE_URLS.applications, `/v1/applications${suffix}`, { accessToken });
}

export function getApplication(applicationId: string, accessToken: string): Promise<ApplicationResponse> {
  return apiFetch<ApplicationResponse>(SERVICE_URLS.applications, `/v1/applications/${encodeURIComponent(applicationId)}`, {
    accessToken,
  });
}

/** Appends a lifecycle event; the response is the application's updated owner view. */
export function appendApplicationEvent(
  applicationId: string,
  event: AppendApplicationEventRequest,
  accessToken: string,
): Promise<ApplicationResponse> {
  return apiFetch<ApplicationResponse>(
    SERVICE_URLS.applications,
    `/v1/applications/${encodeURIComponent(applicationId)}/events`,
    { method: 'POST', body: event, accessToken },
  );
}

type ApplicationItem = ApplicationResponse['application'];

const LOOKUP_PAGE_SIZE = 100;
const LOOKUP_MAX_PAGES = 5;

/**
 * The caller's application for one job, or null. The list endpoint has no
 * job filter, so this walks the (newest-first) pages until it finds it, giving
 * up after a few hundred applications rather than looping forever.
 */
export async function findApplicationForJobId(jobId: string, accessToken: string): Promise<ApplicationItem | null> {
  let cursor: string | null = null;
  for (let page = 0; page < LOOKUP_MAX_PAGES; page++) {
    const result: ListApplicationsResponse = await listApplications(accessToken, { limit: LOOKUP_PAGE_SIZE, cursor });
    const match = result.items.find((item) => item.job_id === jobId);
    if (match) return match;
    if (!result.next_cursor) return null;
    cursor = result.next_cursor;
  }
  return null;
}
