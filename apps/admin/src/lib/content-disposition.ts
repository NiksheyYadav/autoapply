/**
 * The export's file name comes from the `Content-Disposition` header. It is
 * server-chosen but still crosses a trust boundary on its way to a download
 * dialog, so only a short, plain `[A-Za-z0-9._-]` name ending in `.csv` is
 * ever used; anything else falls back to `fallback`.
 */
export function filenameFromContentDisposition(header: string | null, fallback: string): string {
  if (header) {
    const quoted = /filename\s*=\s*"([^"]{1,100})"/i.exec(header);
    const bare = /filename\s*=\s*([^;\s]{1,100})/i.exec(header);
    const raw = quoted?.[1] ?? bare?.[1];
    if (raw && /^[A-Za-z0-9._-]+$/.test(raw) && /\.csv$/i.test(raw) && !raw.startsWith('.')) {
      return raw;
    }
  }
  return fallback;
}
