/**
 * Lenient timestamp parsing for values that come back from the backend.
 *
 * applications-service serialises Postgres `timestamptz` columns as Postgres
 * prints them (`2026-10-27 12:59:21.123+00`: a space instead of `T`, a bare
 * `+00` offset, up to microsecond precision). `isoTimestampSchema` rejects that
 * shape, and engines disagree on `new Date()` for it, so a strict zod parse
 * would throw for every real row and a bare `new Date(value)` would work in
 * Chrome and give "Invalid Date" elsewhere. This normalises the shapes we have
 * seen, and returns `null` (never throws, never an Invalid Date) for anything
 * it cannot trust.
 *
 * Pure and dependency-free so it can be unit tested without a DOM.
 */

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `+00` -> `+00:00`, `+0530` -> `+05:30`, `z` -> `Z`; absent means UTC (the backend only emits UTC). */
function normaliseOffset(raw: string | undefined): string {
  if (raw === undefined || raw.toUpperCase() === 'Z') return 'Z';
  const sign = raw.charAt(0);
  const digits = raw.slice(1).replace(':', '');
  const hours = digits.slice(0, 2);
  const minutes = digits.length > 2 ? digits.slice(2, 4) : '00';
  return `${sign}${hours}:${minutes}`;
}

export function parseServiceTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = TIMESTAMP_PATTERN.exec(value.trim());
  if (!match) return null;

  const [, year = '', month = '', day = '', hour = '00', minute = '00', second = '00', fraction = '', offset] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  // `new Date('2026-02-31')` silently rolls over to March, so check the day ourselves.
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;

  // Millisecond precision is all a Date holds; extra digits are truncated, not rounded.
  const millis = fraction.padEnd(3, '0').slice(0, 3);
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}${normaliseOffset(offset)}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface FormatDateOptions {
  /** Shown when the value is missing or unparseable. */
  fallback?: string;
  /** BCP 47 tag; defaults to the viewer's locale. */
  locale?: string;
  /** IANA zone; defaults to the viewer's. Tests pin it to stay deterministic. */
  timeZone?: string;
}

/** A short calendar date (`Oct 27, 2026`), or the fallback when the value can't be read. */
export function formatServiceDate(value: unknown, options: FormatDateOptions = {}): string {
  const { fallback = 'Unknown date', locale, timeZone } = options;
  const date = parseServiceTimestamp(value);
  if (!date) return fallback;
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone });
}
