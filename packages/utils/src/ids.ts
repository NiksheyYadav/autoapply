import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

export function newUuid(): string {
  return randomUUID();
}

/** URL-safe opaque token. Used for refresh tokens and idempotency keys. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Constant-time comparison for secrets. Length is compared first because
 * timingSafeEqual throws on mismatched buffers — that leak is acceptable since
 * token lengths are fixed by construction.
 */
export function secureEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Cursor pagination is opaque to clients; base64url keeps it that way. */
export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Record<string, string | number> | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
    return decoded as Record<string, string | number>;
  } catch {
    return null;
  }
}

// What Postgres emits for timestamptz in drizzle's string mode, e.g. 2026-10-27 12:34:56.123456+00.
const PG_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CURSOR_SCORE = 1_000_000_000;

/** True for a timestamp Postgres will accept (a real calendar date and clock time, a plausible year and offset). */
function isPostgresTimestamp(text: string): boolean {
  const match = PG_TIMESTAMP.exec(text);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const realDate =
    year >= 1000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  const offsetHours = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinutes = match[8] === undefined ? 0 : Number(match[8]);
  return realDate && hour <= 23 && minute <= 59 && second <= 59 && offsetHours <= 15 && offsetMinutes <= 59;
}

function invalidCursor(): AppError {
  return new AppError('VALIDATION_ERROR', 'Invalid cursor', {
    details: [{ path: 'cursor', message: 'Not a cursor this API issued' }],
  });
}

/**
 * Reads a `{ createdAt, id }` page cursor, as `encodeCursor` writes it for lists ordered by creation time.
 * A cursor is opaque, but a client can send any string: one that is not exactly what this API
 * issues used to reach the database as a timestamp or a uuid and come back as a 500, or was
 * silently ignored. Anything else than `undefined` (no cursor, the first page) that does not check
 * out is a 400.
 */
export function parseTimeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (cursor === undefined) return null;
  const decoded = decodeCursor(cursor);
  const createdAt = decoded?.createdAt;
  const id = decoded?.id;
  if (typeof createdAt !== 'string' || typeof id !== 'string' || !isPostgresTimestamp(createdAt) || !UUID.test(id)) {
    throw invalidCursor();
  }
  return { createdAt, id };
}

/** Reads a `{ score, id }` page cursor, for lists ordered by a score. Same rules as {@link parseTimeCursor}. */
export function parseScoreCursor(cursor: string | undefined): { score: number; id: string } | null {
  if (cursor === undefined) return null;
  const decoded = decodeCursor(cursor);
  const score = decoded?.score;
  const id = decoded?.id;
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    Math.abs(score) > MAX_CURSOR_SCORE ||
    typeof id !== 'string' ||
    !UUID.test(id)
  ) {
    throw invalidCursor();
  }
  return { score, id };
}
