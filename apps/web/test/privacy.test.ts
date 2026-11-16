import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import {
  DELETE_CONFIRMATION,
  deleteAccount,
  describePrivacyError,
  downloadAccountExport,
  exportFilename,
  isDeleteConfirmed,
} from '../src/lib/services/privacy';

const BASE = 'https://api.example.test';
const TOKEN = 'header.payload.signature';

interface Captured {
  url: string;
  init: RequestInit;
}

/** Replaces the global fetch with one canned response and records what it was asked. */
function stubFetch(respond: () => Response): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  });
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const apiError = (status: number, code: string, message: string) =>
  json({ error: { code, message, request_id: 'req-1' } }, status);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isDeleteConfirmed', () => {
  it.each([
    ['DELETE', true],
    ['  DELETE  ', true],
    ['DELETE\n', true],
    ['delete', false],
    ['Delete', false],
    ['DELET', false],
    ['DELETE ME', false],
    ['DELETEDELETE', false],
    ['', false],
    ['   ', false],
  ])('%j -> %s', (typed, expected) => {
    expect(isDeleteConfirmed(typed)).toBe(expected);
  });

  it('sends the same word the person is asked to type', () => {
    expect(DELETE_CONFIRMATION).toBe('DELETE');
  });
});

describe('exportFilename', () => {
  it('is dated in UTC and carries nothing about the person', () => {
    expect(exportFilename(new Date('2026-10-27T23:59:59.000Z'))).toBe('atlas-data-export-2026-10-27.json');
    expect(exportFilename(new Date('2026-01-02T00:00:00.000Z'))).toBe('atlas-data-export-2026-01-02.json');
    expect(exportFilename()).toMatch(/^atlas-data-export-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

describe('downloadAccountExport', () => {
  it('asks the auth service for the export with the token in the Authorization header, never in the URL', async () => {
    const calls = stubFetch(() => json({ export_version: 1, user: { user_id: 'u' } }, 200, { 'content-disposition': 'attachment; filename="x.json"' }));

    const file = await downloadAccountExport(TOKEN, { baseUrl: BASE, now: new Date('2026-10-27T10:00:00Z') });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/auth/me/export`);
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });

    expect(file.filename).toBe('atlas-data-export-2026-10-27.json');
    expect(file.blob.type).toBe('application/json');
    expect(JSON.parse(await file.blob.text())).toEqual({ export_version: 1, user: { user_id: 'u' } });
  });

  it('delivers the bytes untouched, however large', async () => {
    const big = JSON.stringify({ text: 'é'.repeat(200_000) });
    stubFetch(() => new Response(big, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));

    const file = await downloadAccountExport(TOKEN, { baseUrl: BASE });

    expect(await file.blob.text()).toBe(big);
  });

  it.each([
    [401, 'UNAUTHENTICATED', 'Access token has expired'],
    [429, 'RATE_LIMITED', 'Rate limit exceeded, retry in 1 hour'],
    [404, 'USER_NOT_FOUND', 'User no longer exists'],
  ])('turns the API error envelope for %s into an ApiError', async (status, code, message) => {
    stubFetch(() => apiError(status, code, message));

    const error = await downloadAccountExport(TOKEN, { baseUrl: BASE }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code, message });
  });

  it('copes with an error that is not our envelope (a gateway page), without throwing a parse error', async () => {
    stubFetch(() => new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/html' } }));

    const error = await downloadAccountExport(TOKEN, { baseUrl: BASE }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });

  it('refuses a 200 that is not JSON, rather than saving someone else\'s page as the data file', async () => {
    stubFetch(() => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }));

    await expect(downloadAccountExport(TOKEN, { baseUrl: BASE })).rejects.toBeInstanceOf(ApiError);
  });

  it('lets a network failure through as-is for the caller to describe', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(downloadAccountExport(TOKEN, { baseUrl: BASE })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('deleteAccount', () => {
  const deleted = {
    status: 'deleted',
    deleted_at: '2026-10-27T10:00:00.000Z',
    organizations_deleted: 1,
    resume_files: { total: 2, failed: 0 },
  };

  it('sends DELETE /v1/auth/me with the exact confirmation body and the token', async () => {
    const calls = stubFetch(() => json(deleted));

    const result = await deleteAccount(TOKEN, { baseUrl: BASE });

    expect(result).toEqual(deleted);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/auth/me`);
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.init.body).toBe('{"confirm":"DELETE"}');
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` });
  });

  it('surfaces the API\'s refusal with its own explanation', async () => {
    const message = 'You are the only owner of an organization that has other members.';
    stubFetch(() => apiError(409, 'CONFLICT', message));

    const error = await deleteAccount(TOKEN, { baseUrl: BASE }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'CONFLICT', message });
  });
});

describe('describePrivacyError', () => {
  const error = (status: number, message = 'server words') => new ApiError(status, 'CODE', message);

  it('uses the API\'s own words only for a refused deletion, which are written for the person', () => {
    expect(describePrivacyError(error(409, 'Disconnect your connected account first.'), 'delete')).toBe(
      'Disconnect your connected account first.',
    );
  });

  it.each(['export', 'delete'] as const)('never shows a raw status line or server message for other %s failures', (action) => {
    for (const status of [400, 403, 404, 500, 502, 503]) {
      const text = describePrivacyError(error(status, 'internal detail: pg connection refused'), action);
      expect(text).not.toContain('internal detail');
      expect(text).not.toContain('pg connection');
      expect(text).not.toMatch(/\b(400|403|404|500|502|503)\b/);
    }
  });

  it('tells an expired session and a throttled client apart from a failure', () => {
    expect(describePrivacyError(error(401), 'export')).toMatch(/session has expired/i);
    expect(describePrivacyError(error(429), 'delete')).toMatch(/too many attempts/i);
    expect(describePrivacyError(error(404), 'export')).toMatch(/couldn't find your account/i);
  });

  it('does not promise that nothing changed when a delete fails: the request may have got through', () => {
    const text = describePrivacyError(new TypeError('Failed to fetch'), 'delete');
    expect(text).toBe("We couldn't complete the deletion. Please try again.");
    expect(text).not.toMatch(/nothing (was|has been) (changed|deleted)/i);
  });

  it('has a plain sentence for each action when the failure is not an API error', () => {
    expect(describePrivacyError(new TypeError('Failed to fetch'), 'export')).toBe("We couldn't prepare your download. Please try again.");
    expect(describePrivacyError('weird', 'delete')).toBe("We couldn't complete the deletion. Please try again.");
  });
});
