/**
 * A fresh `Idempotency-Key` (the API accepts 8–200 characters). One key is
 * created per chosen file and reused for retries of that same file, so a
 * connection that drops after the server committed cannot import twice.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
