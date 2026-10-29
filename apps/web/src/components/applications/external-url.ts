/**
 * Gatekeeper for any URL that originated outside Atlas (a job's apply link
 * comes from a third-party feed) before it is put in an `href`.
 *
 * Returns the browser's own normalised form of the URL when it is a plain
 * `http:` / `https:` link, otherwise `null`. Rendering the normalised `href`
 * rather than the raw input means what we validated is exactly what gets
 * navigated to. Rejected: `javascript:`, `data:`, `file:`, `blob:` and every
 * other scheme; relative and protocol-relative strings; URLs with embedded
 * credentials (`https://trusted.com@evil.com`, a classic lookalike trick);
 * anything with whitespace or control characters; absurd lengths.
 */

const MAX_URL_LENGTH = 2048;

// eslint-disable-next-line no-control-regex -- detecting control characters is the point
const WHITESPACE_OR_CONTROL = /[\u0000- \u007f-\u009f]/;

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return null;
  // URL parsers silently drop tabs/newlines (`java\tscript:` is `javascript:`),
  // so refuse them outright instead of reasoning about what survives parsing.
  if (WHITESPACE_OR_CONTROL.test(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hostname === '') return null;
  return url.href;
}

/** The host to show next to an "opens on another site" button, e.g. `boards.greenhouse.io`. */
export function externalUrlHost(value: unknown): string | null {
  const safe = safeExternalUrl(value);
  if (!safe) return null;
  return new URL(safe).hostname.replace(/^www\./, '');
}
