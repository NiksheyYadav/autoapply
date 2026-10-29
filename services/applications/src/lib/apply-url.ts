/**
 * `jobs.apply_url` is connector-supplied text. Jobs-service normalizes it with
 * `new URL(...)`, which still accepts `javascript:`, `data:`, `file:` and
 * friends — fine for storage, but never for a link the web app will render and
 * the user will click. Only http(s) is handed out here; anything else is null.
 *
 * URLs carrying embedded credentials (`https://trusted.example@evil.example`)
 * are dropped too: that shape exists to disguise the real host. The returned
 * string is the parsed, canonical `href`, so what was validated is exactly
 * what is served.
 */
export function toSafeApplyUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  return parsed.href;
}
