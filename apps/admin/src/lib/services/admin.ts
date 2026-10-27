import type { AdminFunnelResponse, ImportStudentsResponse, ListAdminStudentsResponse } from '@atlas/types';
import type { ZodType } from 'zod';
import { ApiError, INVALID_RESPONSE_CODE, apiFetchBlob, apiRequest } from '../api';
import { SERVICE_URLS } from '../config';
import {
  adminFunnelResponseSchema,
  importStudentsResponseSchema,
  listAdminStudentsResponseSchema,
} from '../contracts';
import { filenameFromContentDisposition } from '../content-disposition';
import { funnelQueryString, type FunnelQuery } from '../funnel';
import { isOrganizationId } from '../org';
import { filterParams, rosterQuery, type RosterFilterState } from '../roster-query';

/**
 * Client for admin-service (`/v1/admin/organizations/:orgId/…`). Authorization
 * is the server's: membership of `:orgId` with an owner/admin role in a
 * university organization (404 for non-members, 403 otherwise). Nothing here
 * logs, caches or stores a response; roster data lives only in React state.
 */

function orgPath(organizationId: string, suffix: string): string {
  // The id comes from the address bar. Refuse anything that is not a UUID
  // rather than interpolating it into a request path.
  if (!isOrganizationId(organizationId)) {
    throw new ApiError(404, 'NOT_FOUND', 'Not a valid organization id');
  }
  return `/v1/admin/organizations/${encodeURIComponent(organizationId)}${suffix}`;
}

/** Validates a 2xx body against the shared contract so a drifting server fails loudly, not as `undefined` in a table. */
function parseResponse<T>(schema: ZodType<T>, status: number, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(status, INVALID_RESPONSE_CODE, 'The response did not match the expected contract');
  }
  return parsed.data;
}

export async function listStudents(
  accessToken: string,
  organizationId: string,
  filter: RosterFilterState,
  page: { limit: number; cursor: string | null },
  signal?: AbortSignal,
): Promise<ListAdminStudentsResponse> {
  const response = await apiRequest<unknown>(
    SERVICE_URLS.admin,
    `${orgPath(organizationId, '/students')}?${rosterQuery(filter, page)}`,
    { accessToken, signal },
  );
  return parseResponse(listAdminStudentsResponseSchema, response.status, response.data);
}

export async function getFunnel(
  accessToken: string,
  organizationId: string,
  range: FunnelQuery,
  signal?: AbortSignal,
): Promise<AdminFunnelResponse> {
  const query = funnelQueryString(range);
  const response = await apiRequest<unknown>(
    SERVICE_URLS.admin,
    `${orgPath(organizationId, '/funnel')}${query === '' ? '' : `?${query}`}`,
    { accessToken, signal },
  );
  return parseResponse(adminFunnelResponseSchema, response.status, response.data);
}

export interface ImportOutcome {
  result: ImportStudentsResponse;
  /** The server answered from a saved earlier result instead of running the import again. */
  replayed: boolean;
}

/**
 * Sends the CSV file as the raw `text/csv` body (the API accepts exactly that;
 * no multipart). `idempotencyKey` must be reused only for the very same file.
 */
export async function importStudents(
  accessToken: string,
  organizationId: string,
  file: Blob,
  idempotencyKey: string,
): Promise<ImportOutcome> {
  const response = await apiRequest<unknown>(SERVICE_URLS.admin, orgPath(organizationId, '/students/import'), {
    method: 'POST',
    accessToken,
    rawBody: file,
    headers: { 'content-type': 'text/csv', 'idempotency-key': idempotencyKey },
  });
  return {
    result: parseResponse(importStudentsResponseSchema, response.status, response.data),
    replayed: response.headers.get('idempotent-replayed') === 'true',
  };
}

export interface ExportedFile {
  blob: Blob;
  filename: string;
}

/** Downloads the roster (optionally filtered) as CSV. The server records the export in the audit log. */
export async function exportStudents(
  accessToken: string,
  organizationId: string,
  filter: RosterFilterState,
  fallbackFilename: string,
): Promise<ExportedFile> {
  const query = filterParams(filter).toString();
  const { blob, headers } = await apiFetchBlob(
    SERVICE_URLS.admin,
    `${orgPath(organizationId, '/export.csv')}${query === '' ? '' : `?${query}`}`,
    { accessToken },
  );
  return {
    blob,
    filename: filenameFromContentDisposition(headers.get('content-disposition'), fallbackFilename),
  };
}
