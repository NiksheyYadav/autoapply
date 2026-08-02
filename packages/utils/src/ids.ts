import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

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
