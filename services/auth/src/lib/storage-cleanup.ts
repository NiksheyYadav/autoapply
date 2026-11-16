import type { StorageDriver } from '@atlas/storage';

export interface StorageCleanupResult {
  total: number;
  failed: number;
  /** Distinct error classes of the failures (a code or a name, never a message), for the log. */
  failureKinds: string[];
}

/** Per file. The storage driver has its own request timeout; this caps the whole step inside the function's time budget. */
export const STORAGE_DELETE_TIMEOUT_MS = 10_000;

function failureKind(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    const name = (cause as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return 'unknown';
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Removes stored files, best effort: this runs after the database transaction has
 * committed, so a failure here must not turn a completed deletion into an error
 * response. Returns counts instead; the caller logs them.
 *
 * Nothing about the files is reported beyond a count and error classes: not their
 * keys, names or the driver's error messages, which can carry either.
 */
export async function removeStoredFiles(
  storage: StorageDriver,
  keys: readonly string[],
  timeoutMs: number = STORAGE_DELETE_TIMEOUT_MS,
): Promise<StorageCleanupResult> {
  const outcomes = await Promise.allSettled(
    keys.map((key) => withTimeout(Promise.resolve().then(() => storage.delete(key)), timeoutMs)),
  );

  const kinds = new Set<string>();
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      failed += 1;
      kinds.add(failureKind(outcome.reason));
    }
  }
  return { total: keys.length, failed, failureKinds: [...kinds].sort() };
}
