import { createHash, timingSafeEqual } from 'node:crypto';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Checks an `Authorization: Bearer <secret>` header against the configured
 * `CRON_SECRET`, which is exactly what Vercel Cron sends when that variable
 * is set on the project.
 *
 * Both sides are hashed first, so the comparison is over two fixed-length
 * buffers: constant time, and no length oracle for the secret. A missing or
 * non-Bearer header is compared as the empty string rather than returning
 * early, so every rejection takes the same path.
 */
export function isAuthorizedDrainRequest(
  authorization: string | undefined,
  secret: string,
): boolean {
  if (secret === '') return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  const presented = match?.[1] ?? '';
  const equal = timingSafeEqual(digest(presented), digest(secret));
  return equal && match !== null;
}
