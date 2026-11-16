import type { DeleteAccountRequest, DeleteAccountResponse } from '@atlas/types';
import { ApiError, apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

/**
 * The text the API requires in `{ confirm }`. Typed against the shared contract,
 * with a type-only import, so the two cannot drift apart and no runtime code from
 * @atlas/types is pulled into the page.
 */
export const DELETE_CONFIRMATION = 'DELETE' satisfies DeleteAccountRequest['confirm'];

/**
 * Whether what the person typed counts as the confirmation. Exact and case-sensitive
 * (so "delete" does not count) apart from surrounding whitespace, which phone
 * keyboards and paste add without anyone meaning it.
 */
export function isDeleteConfirmed(typed: string): boolean {
  return typed.trim() === DELETE_CONFIRMATION;
}

/** `atlas-data-export-2026-10-27.json`: the day in UTC, and nothing that identifies the person. */
export function exportFilename(now: Date = new Date()): string {
  return `atlas-data-export-${now.toISOString().slice(0, 10)}.json`;
}

export interface AccountExportFile {
  blob: Blob;
  filename: string;
}

interface Options {
  baseUrl?: string;
  now?: Date;
}

/** Not every failure is our JSON envelope (a gateway error is plain text or HTML), so read it defensively. */
async function toApiError(res: Response): Promise<ApiError> {
  let code = 'INTERNAL_ERROR';
  let message = res.statusText;
  try {
    const parsed = JSON.parse(await res.text()) as { error?: { code?: string; message?: string } };
    code = parsed.error?.code ?? code;
    message = parsed.error?.message ?? message;
  } catch {
    // Keep the status line.
  }
  return new ApiError(res.status, code, message);
}

/**
 * GET /v1/auth/me/export with the caller's access token, as a blob ready to save.
 * The token goes in the Authorization header, so this is a `fetch`, not a link.
 */
export async function downloadAccountExport(accessToken: string, options: Options = {}): Promise<AccountExportFile> {
  const res = await fetch(`${options.baseUrl ?? SERVICE_URLS.auth}/v1/auth/me/export`, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw await toApiError(res);

  // A 200 that is not JSON is some other layer answering (a misrouted request, a login page): not a data file.
  if (!(res.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    throw new ApiError(res.status, 'INTERNAL_ERROR', 'The server did not return a data file');
  }
  const body = await res.blob();
  return { blob: new Blob([body], { type: 'application/json' }), filename: exportFilename(options.now) };
}

/** DELETE /v1/auth/me. Resolves with the server's account of what was removed; rejects with an ApiError otherwise. */
export function deleteAccount(accessToken: string, options: Pick<Options, 'baseUrl'> = {}): Promise<DeleteAccountResponse> {
  const body: DeleteAccountRequest = { confirm: DELETE_CONFIRMATION };
  return apiFetch<DeleteAccountResponse>(options.baseUrl ?? SERVICE_URLS.auth, '/v1/auth/me', {
    method: 'DELETE',
    body,
    accessToken,
  });
}

/**
 * What to tell the person when one of the two requests failed. The API's own
 * wording is used only where it is written for them (the 409 refusals say what to
 * do next); everything else is a fixed sentence, never a status line or a code.
 */
export function describePrivacyError(cause: unknown, action: 'export' | 'delete'): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return 'Your session has expired. Sign in again, then try once more.';
    if (cause.status === 429) return 'Too many attempts. Please wait a while before trying again.';
    if (cause.status === 409 && action === 'delete') return cause.message;
    if (cause.status === 404) return "We couldn't find your account. It may have been deleted already.";
  }
  return action === 'export'
    ? "We couldn't prepare your download. Please try again."
    : "We couldn't complete the deletion. Please try again.";
}

/** Hands a blob to the browser as a file download. Browser-only. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Some browsers start reading the blob after the click returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
