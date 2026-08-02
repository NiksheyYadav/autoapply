/**
 * Log redaction (docs/09 § Data protection). Applied by the shared logger so a
 * service cannot accidentally opt out.
 */

/** Field names whose values are replaced wholesale wherever they appear. */
export const REDACTED_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'access_token',
  'refresh_token',
  'authorization',
  'cookie',
  'set-cookie',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'private_key',
  'jwt_secret',
  'token',
  'parsed_text',
]);

export const REDACTED = '[redacted]';

/** `ada.lovelace@example.com` → `ad***@example.com` */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return REDACTED;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const keep = local.slice(0, Math.min(2, local.length));
  return `${keep}***@${domain}`;
}

export function maskToken(token: string): string {
  if (token.length <= 8) return REDACTED;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

const MAX_DEPTH = 8;

/**
 * Deep-copies a value, replacing sensitive fields. Depth-limited so a cyclic or
 * pathological object can never stall the logging path.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (REDACTED_KEYS.has(lower)) {
      out[key] = REDACTED;
    } else if (lower === 'email' && typeof val === 'string') {
      out[key] = maskEmail(val);
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}
