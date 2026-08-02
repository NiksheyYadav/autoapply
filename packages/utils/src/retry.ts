export interface BackoffOptions {
  /** Delay before the first retry, in ms. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Fraction of the computed delay applied as random jitter. 0–1. */
  jitter?: number;
}

const DEFAULTS = { baseDelayMs: 500, maxDelayMs: 60_000, jitter: 0.3 } as const;

/**
 * Exponential backoff with jitter (docs/06 § Processing rules). Jitter is
 * essential here: connector failures tend to hit every worker at once, and
 * un-jittered retries would reproduce the thundering herd on each attempt.
 *
 * @param attempt zero-based retry number
 * @param random injectable for deterministic tests
 */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const { baseDelayMs, maxDelayMs, jitter } = { ...DEFAULTS, ...options };
  const exponential = Math.min(baseDelayMs * 2 ** Math.max(0, attempt), maxDelayMs);
  const jitterRange = exponential * jitter;
  const offset = (random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(exponential + offset));
}

export interface RetryOptions extends BackoffOptions {
  maxAttempts?: number;
  /** Return false to fail fast on non-transient errors. */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const isRetryable = options.isRetryable ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !isRetryable(error)) break;
      const delay = backoffDelayMs(attempt, options);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
