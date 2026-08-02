import { describe, expect, it } from 'vitest';
import { AppError, toAppError } from '../src/errors.js';
import { decodeCursor, encodeCursor, secureEquals, sha256Hex } from '../src/ids.js';
import { maskEmail, maskToken, redact, REDACTED } from '../src/redact.js';
import { backoffDelayMs, withRetry } from '../src/retry.js';

describe('AppError', () => {
  it('maps codes to status codes and serializes the documented error envelope', () => {
    const error = new AppError('JOB_NOT_FOUND', 'Job is unavailable');
    expect(error.statusCode).toBe(404);
    expect(error.toResponse('req-1')).toEqual({
      error: { code: 'JOB_NOT_FOUND', message: 'Job is unavailable', request_id: 'req-1' },
    });
  });

  it('withholds internal error messages from clients', () => {
    const error = toAppError(new Error('connection string parse failed at :5432'));
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.statusCode).toBe(500);
    expect(error.toResponse('req-2').error.message).toBe('An unexpected error occurred');
  });

  it('passes AppErrors through unchanged', () => {
    const original = new AppError('CONFLICT', 'nope');
    expect(toAppError(original)).toBe(original);
  });
});

describe('redaction', () => {
  it('masks emails while keeping the domain for debugging', () => {
    expect(maskEmail('ada.lovelace@example.com')).toBe('ad***@example.com');
    expect(maskEmail('not-an-email')).toBe(REDACTED);
  });

  it('masks tokens but leaves short values fully hidden', () => {
    expect(maskToken('abcdefghijklmnop')).toBe('abcd…mnop');
    expect(maskToken('short')).toBe(REDACTED);
  });

  it('recursively strips sensitive keys', () => {
    const input = {
      email: 'ada@example.com',
      password: 'hunter2hunter2',
      nested: { refresh_token: 'secret-value', keep: 'visible' },
      list: [{ api_key: 'k' }],
    };
    expect(redact(input)).toEqual({
      email: 'ad***@example.com',
      password: REDACTED,
      nested: { refresh_token: REDACTED, keep: 'visible' },
      list: [{ api_key: REDACTED }],
    });
  });

  it('is depth-limited so cyclic objects cannot stall logging', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });
});

describe('backoff', () => {
  it('grows exponentially and respects the ceiling', () => {
    const noJitter = { jitter: 0, baseDelayMs: 500, maxDelayMs: 8000 };
    expect(backoffDelayMs(0, noJitter)).toBe(500);
    expect(backoffDelayMs(1, noJitter)).toBe(1000);
    expect(backoffDelayMs(2, noJitter)).toBe(2000);
    expect(backoffDelayMs(20, noJitter)).toBe(8000);
  });

  it('applies jitter within the configured band', () => {
    const opts = { jitter: 0.5, baseDelayMs: 1000, maxDelayMs: 10_000 };
    expect(backoffDelayMs(0, opts, () => 0)).toBe(500);
    expect(backoffDelayMs(0, opts, () => 1)).toBe(1500);
    expect(backoffDelayMs(0, opts, () => 0.5)).toBe(1000);
  });

  it('never returns a negative delay', () => {
    expect(backoffDelayMs(0, { jitter: 2, baseDelayMs: 100 }, () => 0)).toBe(0);
  });
});

describe('withRetry', () => {
  const noSleep = async () => {};

  it('returns the first successful result', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return 'ok';
      },
      { sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries transient failures up to maxAttempts', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        return calls;
      },
      { maxAttempts: 3, sleep: noSleep },
    );
    expect(result).toBe(3);
  });

  it('fails fast when the error is not retryable', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new AppError('VALIDATION_ERROR', 'bad input');
        },
        { maxAttempts: 5, sleep: noSleep, isRetryable: () => false },
      ),
    ).rejects.toThrow('bad input');
    expect(calls).toBe(1);
  });

  it('rethrows the last error once attempts are exhausted', async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error('always down');
        },
        { maxAttempts: 2, sleep: noSleep },
      ),
    ).rejects.toThrow('always down');
  });
});

describe('ids', () => {
  it('round-trips cursors', () => {
    const cursor = encodeCursor({ created_at: '2026-01-01T00:00:00.000Z', id: 'abc' });
    expect(decodeCursor(cursor)).toEqual({ created_at: '2026-01-01T00:00:00.000Z', id: 'abc' });
  });

  it('returns null for malformed cursors instead of throwing', () => {
    expect(decodeCursor('not-base64-json')).toBeNull();
    expect(decodeCursor(Buffer.from('[1,2]', 'utf8').toString('base64url'))).toBeNull();
  });

  it('compares secrets without leaking on length', () => {
    expect(secureEquals('abc', 'abc')).toBe(true);
    expect(secureEquals('abc', 'abd')).toBe(false);
    expect(secureEquals('abc', 'abcd')).toBe(false);
  });

  it('hashes deterministically', () => {
    expect(sha256Hex('atlas')).toBe(sha256Hex('atlas'));
    expect(sha256Hex('atlas')).toHaveLength(64);
  });
});
