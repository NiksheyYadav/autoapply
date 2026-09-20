import { z } from 'zod';

/**
 * Identifiers are UUIDv4 strings everywhere. They are plain `string` at the
 * type level so they pass through Drizzle and JSON without ceremony, but every
 * boundary validates them with {@link uuidSchema}.
 */
export const uuidSchema = z.uuid();

export type Uuid = string;
export type UserId = Uuid;
export type OrganizationId = Uuid;
export type ResumeId = Uuid;
export type JobId = Uuid;
export type CompanyId = Uuid;
export type ApplicationId = Uuid;
export type ContactId = Uuid;

/** ISO-8601 timestamp, always UTC. */
export const isoTimestampSchema = z.iso.datetime();

/**
 * Canonical error codes. The API error model in docs/04 requires a stable
 * machine-readable `code`, so this list is the contract — add to it rather than
 * inventing ad-hoc strings at call sites.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'JOB_NOT_FOUND',
  'RESUME_NOT_FOUND',
  'USER_NOT_FOUND',
  'EMAIL_ALREADY_REGISTERED',
  'INVALID_CREDENTIALS',
  'SESSION_EXPIRED',
  'CONNECTOR_FAILURE',
  'UPSTREAM_UNAVAILABLE',
  'OAUTH_PROVIDER_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

/** Wire format for every non-2xx response (docs/04 § Error model). */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    request_id: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Cursor pagination envelope used by all list endpoints. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/**
 * Correlation metadata carried on every request, log line, and queue message
 * (docs/06 § Processing rules, docs/10 § Observability).
 */
export const traceContextSchema = z.object({
  trace_id: z.string(),
  correlation_id: z.string(),
  organization_id: uuidSchema.nullable(),
  user_id: uuidSchema.nullable(),
});

export type TraceContext = z.infer<typeof traceContextSchema>;

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  checks: Record<string, 'ok' | 'fail' | 'skipped'>;
}
