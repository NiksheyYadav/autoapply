import type { ZodType } from 'zod';
import { rawJobPostingSchema, type JobBoardProvider, type RawJobPosting } from '@atlas/types';
import { tidyWhitespace } from './html-text.js';

/**
 * Column and schema limits the mappers clamp to. `title` is narrower than
 * `rawJobPostingSchema` allows (500) because `jobs.title` is varchar(300): a
 * longer one would pass validation and then fail the insert.
 */
export const FIELD_LIMITS = {
  title: 300,
  externalId: 400,
  location: 300,
  description: 200_000,
  applyUrl: 2_000,
  shortText: 50,
  postedAt: 60,
} as const;

/** What one provider's payload turned into. */
export interface MappedJobs {
  postings: RawJobPosting[];
  /** Entries dropped on purpose: not publicly listed, or too malformed to use. */
  skipped: number;
}

export interface MapperContext {
  /** The employer the board belongs to (`job_sources.company_name`). */
  companyName: string;
}

/** The response was valid JSON but not the shape the provider documents. */
export class SourcePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcePayloadError';
  }
}

/**
 * Characters that have no place in a posting and do harm elsewhere: NUL (Postgres cannot store it,
 * so the posting would be rejected, and one rejected posting stops a board's closed roles from ever
 * being deactivated), the other control characters except tab, line feed and carriage return
 * (they garble logs and terminals), and the bidirectional overrides and isolates that reverse the
 * text around them, which can make a title read as something else.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function stripUnsafeChars(text: string): string {
  return text.replace(UNSAFE_TEXT_CHARS, '');
}

/** Cleaned, trimmed, length-capped text; null when nothing is left. */
export function clampText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = stripUnsafeChars(value).trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? trimmed.slice(0, max).trimEnd() : trimmed;
}

/** Paragraphs of a description as one text; null when every part is blank. */
export function tidyDescription(parts: ReadonlyArray<string | null | undefined>): string | null {
  const text = tidyWhitespace(parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '').join('\n\n'));
  return text === '' ? null : text;
}

/**
 * Joins distinct, non-empty locations with " | ", dropping whole entries that
 * would not fit rather than cutting one in half.
 */
export function joinLocations(
  parts: ReadonlyArray<string | null | undefined>,
  max: number = FIELD_LIMITS.location,
): string | null {
  const seen = new Set<string>();
  let joined = '';
  for (const part of parts) {
    const text = clampText(part, max);
    if (text === null || seen.has(text.toLowerCase())) continue;
    const next = joined === '' ? text : `${joined} | ${text}`;
    if (next.length > max) break;
    seen.add(text.toLowerCase());
    joined = next;
  }
  return joined === '' ? null : joined;
}

const EARLIEST_PLAUSIBLE_YEAR = 1990;

/** An ISO-8601 timestamp, or null for anything that is not a plausible date. */
export function toIsoTimestamp(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined || input === '') return null;
  const date = new Date(input);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  const year = date.getUTCFullYear();
  const latest = new Date().getUTCFullYear() + 1;
  return year >= EARLIEST_PLAUSIBLE_YEAR && year <= latest ? date.toISOString() : null;
}

/** The largest value the `integer` salary columns can hold. */
const MAX_SALARY_AMOUNT = 2_147_483_647;

/** A whole, non-negative amount the salary columns can store, or null. */
export function toWholeAmount(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return null;
  const rounded = Math.round(input);
  return rounded <= MAX_SALARY_AMOUNT ? rounded : null;
}

/** A candidate posting with every limit applied, or null when it is unusable (for example, no title). */
export function finalizePosting(candidate: RawJobPosting): RawJobPosting | null {
  const clamped: RawJobPosting = {
    ...candidate,
    external_id: clampText(candidate.external_id, FIELD_LIMITS.externalId),
    title: clampText(candidate.title, FIELD_LIMITS.title) ?? '',
    description: clampText(candidate.description, FIELD_LIMITS.description),
    location: clampText(candidate.location, FIELD_LIMITS.location),
    remote_type: clampText(candidate.remote_type, FIELD_LIMITS.shortText),
    employment_type: clampText(candidate.employment_type, FIELD_LIMITS.shortText),
    apply_url: clampText(candidate.apply_url, FIELD_LIMITS.applyUrl),
    posted_at: clampText(candidate.posted_at, FIELD_LIMITS.postedAt),
  };
  const parsed = rawJobPostingSchema.safeParse(clamped);
  return parsed.success ? parsed.data : null;
}

/** Reads a value as a record without trusting its shape. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Fixed per-provider API host: the only host a source's requests may go to. */
export interface ProviderAdapter {
  provider: JobBoardProvider;
  /** `https://host` with no path. */
  origin: string;
  /** Builds the request URL from the fixed origin and an already-validated token. */
  buildUrl(boardToken: string): URL;
  /** Pure: provider JSON to postings. Throws {@link SourcePayloadError} for a payload of the wrong shape. */
  map(payload: unknown, context: MapperContext): MappedJobs;
}

/**
 * Maps each entry on its own: an entry that does not fit `itemSchema`, or that
 * `toPosting` rejects, is counted as skipped instead of failing the whole
 * board. Only a wrong top-level shape (checked by the caller) is an error.
 */
export function collectPostings<T>(
  entries: readonly unknown[],
  itemSchema: ZodType<T>,
  toPosting: (item: T) => RawJobPosting | null,
): MappedJobs {
  const postings: RawJobPosting[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const parsed = itemSchema.safeParse(entry);
    const posting = parsed.success ? toPosting(parsed.data) : null;
    const finalized = posting === null ? null : finalizePosting(posting);
    if (finalized === null) skipped += 1;
    else postings.push(finalized);
  }
  return { postings, skipped };
}
