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
 * Validates the `next` query parameter that /auth/callback redirects to after
 * a successful sign-in, so it can't be turned into an open redirect.
 *
 * Only same-origin relative paths are accepted (e.g. `/dashboard?tab=1`).
 * Anything else — absolute URLs, `//host`, `@host`/`.host` (which become
 * userinfo or a lookalike subdomain when concatenated onto an origin),
 * backslashes, control characters, or a percent-encoded form of any of
 * those — returns `fallback`.
 */
export function safeNextPath(next: string | null | undefined, fallback: string = DEFAULT_NEXT_PATH): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > MAX_NEXT_LENGTH) return fallback;
  if (!isSameOriginPath(next)) return fallback;

  // Re-check the decoded form: `/%2F/evil.com` and `/%5Cevil.com` are
  // harmless as-is, but anything downstream that decodes once would not be.
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return fallback;
  }
  return isSameOriginPath(decoded) ? next : fallback;
}
