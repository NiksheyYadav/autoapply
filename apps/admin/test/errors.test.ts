import { describe, expect, it } from 'vitest';
import {
  ApiError,
  INVALID_RESPONSE_CODE,
  NETWORK_ERROR_CODE,
  apiErrorFromResponse,
  parseRetryAfter,
} from '../src/lib/api';
import { describeApiError } from '../src/lib/errors';

const envelope = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ error: { code, message, request_id: 'req-123', ...extra } });

describe('parseRetryAfter', () => {
  it.each([
    ['30', 30],
    [' 7 ', 7],
    ['0', 0],
    ['99999999', undefined],
    ['Wed, 21 Oct 2026 07:28:00 GMT', undefined],
    ['-5', undefined],
    ['1.5', undefined],
    ['', undefined],
    [null, undefined],
  ])('reads %j as %j', (input, expected) => {
    expect(parseRetryAfter(input)).toBe(expected);
  });

  it('caps an absurd wait at one hour', () => {
    expect(parseRetryAfter('999999')).toBe(3600);
  });
});

describe('apiErrorFromResponse', () => {
  it('reads the docs/04 error envelope', () => {
    const error = apiErrorFromResponse(
      413,
      new Headers(),
      envelope('PAYLOAD_TOO_LARGE', 'An import may contain at most 5000 rows', { details: { max_rows: 5000 } }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      requestId: 'req-123',
      details: { max_rows: 5000 },
    });
  });

  it('carries Retry-After from a 429', () => {
    const error = apiErrorFromResponse(
      429,
      new Headers({ 'retry-after': '42' }),
      envelope('RATE_LIMITED', 'Rate limit exceeded'),
    );
    expect(error.retryAfterSeconds).toBe(42);
  });

  it.each([
    ['an HTML gateway page', '<html><body>502 Bad Gateway</body></html>'],
    ['an empty body', ''],
    ['JSON that is not an envelope', '{"hello":"world"}'],
    ['an envelope with the wrong types', '{"error":{"code":5,"message":{}}}'],
    ['a JSON array', '[1,2,3]'],
  ])('does not throw on %s and falls back to the status', (_label, body) => {
    const error = apiErrorFromResponse(502, new Headers(), body);
    expect(error.status).toBe(502);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('Request failed with status 502');
  });

  it('derives a code from the status when the body has none', () => {
    expect(apiErrorFromResponse(401, new Headers(), '').code).toBe('UNAUTHENTICATED');
    expect(apiErrorFromResponse(403, new Headers(), '').code).toBe('FORBIDDEN');
    expect(apiErrorFromResponse(404, new Headers(), '').code).toBe('NOT_FOUND');
    expect(apiErrorFromResponse(413, new Headers(), '').code).toBe('PAYLOAD_TOO_LARGE');
    expect(apiErrorFromResponse(429, new Headers(), '').code).toBe('RATE_LIMITED');
  });

  it('bounds a very long server message', () => {
    const error = apiErrorFromResponse(400, new Headers(), envelope('VALIDATION_ERROR', 'x'.repeat(5000)));
    expect(error.message.length).toBeLessThanOrEqual(300);
  });
});

describe('describeApiError', () => {
  const api = (status: number, code: string, options: ConstructorParameters<typeof ApiError>[3] = {}) =>
    new ApiError(status, code, 'server text', options);

  it('treats a non-ApiError as unknown and retryable', () => {
    expect(describeApiError(new TypeError('boom'))).toMatchObject({ kind: 'unknown', retryable: true });
    expect(describeApiError('nope')).toMatchObject({ kind: 'unknown' });
  });

  it('maps 401 to a sign-in prompt', () => {
    expect(describeApiError(api(401, 'UNAUTHENTICATED'))).toMatchObject({ kind: 'unauthenticated', retryable: false });
  });

  it('maps 404 to "not a member" without claiming which of the two it is', () => {
    const failure = describeApiError(api(404, 'NOT_FOUND'), 'roster');
    expect(failure.kind).toBe('not_member');
    expect(failure.message).toMatch(/does not exist or you are not a member/i);
  });

  it('maps 403 to a role/org-type explanation, and to an operators-only message for the platform view', () => {
    const roster = describeApiError(api(403, 'FORBIDDEN'), 'roster');
    expect(roster).toMatchObject({ kind: 'forbidden', retryable: false });
    expect(roster.message).toMatch(/owner or admin role in a university organization/);

    const platform = describeApiError(api(403, 'FORBIDDEN'), 'platform');
    expect(platform.kind).toBe('forbidden');
    expect(platform.title).toMatch(/platform operators only/i);
    expect(platform.message).toMatch(/Nothing is wrong with your university console/);
  });

  it('uses the server-provided row cap in 413 messages, per context', () => {
    const imported = describeApiError(api(413, 'PAYLOAD_TOO_LARGE', { details: { max_rows: 5000 } }), 'import');
    expect(imported.kind).toBe('too_large');
    expect(imported.message).toContain('5,000 rows');

    const exported = describeApiError(api(413, 'PAYLOAD_TOO_LARGE', { details: { max_rows: 10000 } }), 'export');
    expect(exported.message).toContain('10,000 students');
    expect(exported.message).toMatch(/search or filters/);
  });

  it('copes with 413 details that are missing or hostile', () => {
    for (const details of [undefined, null, 'text', { max_rows: -1 }, { max_rows: '5000' }, { max_rows: 1.5 }]) {
      const failure = describeApiError(api(413, 'PAYLOAD_TOO_LARGE', { details }), 'import');
      expect(failure.kind).toBe('too_large');
      expect(failure.message).not.toMatch(/undefined|NaN|null/);
    }
  });

  it('names the missing and unknown CSV columns from a 400', () => {
    const missing = describeApiError(
      api(400, 'VALIDATION_ERROR', { details: { missing_columns: ['email', 'full_name'] } }),
      'import',
    );
    expect(missing.kind).toBe('validation');
    expect(missing.message).toContain('email, full_name');

    const unknown = describeApiError(
      api(400, 'VALIDATION_ERROR', { details: { unknown_columns: ['nickname'] } }),
      'import',
    );
    expect(unknown.message).toContain('nickname');

    const malformed = describeApiError(api(400, 'VALIDATION_ERROR', { details: { record: 3 } }), 'import');
    expect(malformed.message).toMatch(/quote/);
  });

  it('does not echo arbitrary server text, only vetted copy', () => {
    const failure = describeApiError(
      new ApiError(400, 'VALIDATION_ERROR', 'jane.doe@uni.edu leaked in a message', {
        details: [{ path: 'x', message: 'bad@value.test' }],
      }),
      'roster',
    );
    expect(JSON.stringify(failure)).not.toMatch(/jane\.doe|bad@value/);
  });

  it('maps 429 with and without a Retry-After', () => {
    const waiting = describeApiError(api(429, 'RATE_LIMITED', { retryAfterSeconds: 30 }), 'export');
    expect(waiting).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterSeconds: 30 });
    expect(waiting.message).toContain('30 seconds');
    expect(describeApiError(api(429, 'RATE_LIMITED', { retryAfterSeconds: 1 })).message).toContain('1 second and');
    expect(describeApiError(api(429, 'RATE_LIMITED')).message).toMatch(/Wait a minute/);
  });

  it('separates a reused idempotency key from an in-progress request', () => {
    const reused = describeApiError(api(409, 'IDEMPOTENCY_KEY_REUSED'), 'import');
    expect(reused).toMatchObject({ kind: 'conflict', retryable: false });
    const inProgress = describeApiError(api(409, 'CONFLICT'), 'import');
    expect(inProgress).toMatchObject({ kind: 'conflict', retryable: true });
  });

  it('maps transport failures, bad responses and 5xx', () => {
    expect(describeApiError(api(0, NETWORK_ERROR_CODE))).toMatchObject({ kind: 'network', retryable: true });
    expect(describeApiError(api(200, INVALID_RESPONSE_CODE))).toMatchObject({ kind: 'invalid_response' });
    expect(describeApiError(api(503, 'UPSTREAM_UNAVAILABLE'))).toMatchObject({ kind: 'server', retryable: true });
    expect(describeApiError(api(415, 'UNSUPPORTED_MEDIA_TYPE'), 'import').kind).toBe('unsupported_media');
  });

  it('passes the request id through so support can find the request', () => {
    expect(describeApiError(api(500, 'INTERNAL_ERROR', { requestId: 'abc-1' })).requestId).toBe('abc-1');
  });
});
