/**
 * The name a client gave an uploaded file, made safe to store and to show back.
 *
 * The name is whatever the client's multipart header says. It is kept in a 400-character column and
 * returned to the user, so it must not carry a path (`../../etc/passwd`), a NUL byte (Postgres cannot
 * store it, and the upload used to fail with a 500 after the file had already been stored), other
 * control characters, or a bidirectional override (`resume\u202Egnp.txt` displays reversed). The
 * storage path is built from the user id and the content hash, never from this name.
 */
const FALLBACK_NAME = 'resume';
const MAX_NAME_LENGTH = 255;
const MAX_EXTENSION_LENGTH = 16;

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeFilename(raw: string | undefined | null): string {
  // Only the last path segment, whichever slash the client's system uses.
  const lastSegment = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = lastSegment.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  // A name that is nothing but dots or spaces says nothing; "." and ".." are directory references.
  if (cleaned === '' || /^[. ]+$/.test(cleaned)) return FALLBACK_NAME;
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;

  // Too long: cut the stem, keep a short extension so the file still reads as a .pdf or .docx.
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= MAX_EXTENSION_LENGTH ? cleaned.slice(dot) : '';
  return `${Array.from(cleaned.slice(0, dot > 0 ? dot : cleaned.length)).slice(0, MAX_NAME_LENGTH - extension.length).join('')}${extension}`;
}
