import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';

/**
 * Public employer job boards the jobs service can read automatically. Each is
 * an unauthenticated, read-only endpoint the employer publishes for embedding
 * in its own careers page; the provider names double as `JobSource` values on
 * the jobs they produce (see `JOB_SOURCES`).
 */
export const JOB_BOARD_PROVIDERS = ['greenhouse', 'lever', 'ashby'] as const;
export const jobBoardProviderSchema = z.enum(JOB_BOARD_PROVIDERS);
export type JobBoardProvider = z.infer<typeof jobBoardProviderSchema>;

/**
 * The only caller-controlled part of an outbound request URL. Hosts are fixed
 * per provider, so this charset is what keeps a stored board token from
 * steering a request anywhere else: no dots (no `..` segments, no hostnames),
 * no slashes, `?`, `#`, `@`, `:` or whitespace. Tokens that legitimately contain
 * anything else are not supported.
 */
export const BOARD_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export const jobBoardTokenSchema = z
  .string()
  .regex(BOARD_TOKEN_PATTERN, 'board_token must be 1-100 letters, digits, "-" or "_" and start with a letter or digit');

/** Visible characters only: no control characters, so it is safe to log and to echo back. */
const companyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'company_name must not contain control characters');

/** POST /v1/jobs/sources: upsert on (provider, board_token). */
export const upsertJobBoardSourceRequestSchema = z.object({
  provider: jobBoardProviderSchema,
  board_token: jobBoardTokenSchema,
  /** The employer the board's postings are attributed to (list endpoints do not all report one). */
  company_name: companyNameSchema,
  /** Omitted: a new source starts enabled, an existing one keeps its current state. */
  enabled: z.boolean().optional(),
});

export type UpsertJobBoardSourceRequest = z.infer<typeof upsertJobBoardSourceRequestSchema>;

export const JOB_BOARD_SOURCE_STATUSES = ['ok', 'partial', 'error'] as const;
export const jobBoardSourceStatusSchema = z.enum(JOB_BOARD_SOURCE_STATUSES);
export type JobBoardSourceStatus = z.infer<typeof jobBoardSourceStatusSchema>;

export const jobBoardSourceSchema = z.object({
  source_id: uuidSchema,
  provider: jobBoardProviderSchema,
  board_token: jobBoardTokenSchema,
  company_name: z.string(),
  enabled: z.boolean(),
  last_fetched_at: isoTimestampSchema.nullable(),
  /** `ok` | `partial` | `error`; null until the first attempt. */
  last_status: z.string().nullable(),
  /** Short and scrubbed: never a raw driver or upstream message. */
  last_error: z.string().nullable(),
  last_job_count: z.number().int().nullable(),
  created_at: isoTimestampSchema,
});

export type JobBoardSource = z.infer<typeof jobBoardSourceSchema>;

export const listJobBoardSourcesResponseSchema = z.object({
  items: z.array(jobBoardSourceSchema),
});

export type ListJobBoardSourcesResponse = z.infer<typeof listJobBoardSourcesResponseSchema>;

/** Why a successfully fetched source did not have its vanished postings deactivated. */
export type DeactivationSkipReason = 'empty_result' | 'incomplete_run' | 'rejected_postings' | 'sharp_drop';

/** What one source contributed to an ingestion run. */
export interface JobBoardSourceRunResult {
  source_id: string;
  provider: JobBoardProvider;
  board_token: string;
  status: JobBoardSourceStatus;
  /** Postings the provider listed that mapped to a valid posting. */
  fetched: number;
  /** Provider entries dropped before ingestion: not publicly listed, or unusable. */
  skipped: number;
  inserted: number;
  /** Already stored under another content hash or external id, then rewritten in place. */
  updated: number;
  duplicates: number;
  rejected: number;
  /** Postings marked inactive because the source no longer lists them. */
  deactivated: number;
  deactivation_skipped: DeactivationSkipReason | null;
  duration_ms: number;
  error: string | null;
}

/** Response body of `/internal/jobs/ingest-sources`. */
export interface IngestSourcesReport {
  /** Enabled sources that existed when the run started. */
  sources_total: number;
  attempted: number;
  succeeded: number;
  failed: number;
  /** Not started because the time budget or the `limit` ran out; they go first next time. */
  not_attempted: number;
  inserted: number;
  updated: number;
  duplicates: number;
  rejected: number;
  deactivated: number;
  duration_ms: number;
  sources: JobBoardSourceRunResult[];
}
