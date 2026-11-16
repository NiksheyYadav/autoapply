/** Where a successful sign-in lands when no (valid) `next` is supplied. */
export const DEFAULT_NEXT_PATH = '/dashboard';

const MAX_NEXT_LENGTH = 2048;

/**
 * ASCII control characters, including tab/CR/LF — URL parsers silently strip
 * those, so `/<TAB>/evil.com` would otherwise turn into `//evil.com`.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * A same-origin path: exactly one leading slash (so not protocol-relative),
 * and no backslash, which browsers treat as a slash (`/\evil.com` is
 * `//evil.com` to them).
 */
function isSameOriginPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !hasControlCharacter(value);
}

/**
 * Validates the `next` query parameter the sign-in page redirects to after a
 * successful sign-in, so it cannot be turned into an open redirect. Same rules
 * as apps/web's lib/safe-redirect.ts (copied rather than shared: apps do not
 * import from each other). Only same-origin relative paths are accepted;
 * anything else returns `fallback`.
 */
export function safeNextPath(next: string | null | undefined, fallback: string = DEFAULT_NEXT_PATH): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > MAX_NEXT_LENGTH) return fallback;
  if (!isSameOriginPath(next)) return fallback;

  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return fallback;
  }
  return isSameOriginPath(decoded) ? next : fallback;
}
