import type { ErrorCode, ErrorResponse } from '@atlas/types';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  JOB_NOT_FOUND: 404,
  RESUME_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  EMAIL_ALREADY_REGISTERED: 409,
  INVALID_CREDENTIALS: 401,
  SESSION_EXPIRED: 401,
  CONNECTOR_FAILURE: 502,
  UPSTREAM_UNAVAILABLE: 503,
  OAUTH_PROVIDER_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/**
 * The only error type that should reach an HTTP boundary. Anything else is a
 * bug and gets mapped to INTERNAL_ERROR with its message withheld from the
 * client (docs/09 § Data protection).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;
  /** When false, the message is replaced with a generic string in responses. */
  readonly exposeMessage: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; cause?: unknown; exposeMessage?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = options.details;
    this.exposeMessage = options.exposeMessage ?? code !== 'INTERNAL_ERROR';
  }

  toResponse(requestId: string): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.exposeMessage ? this.message : 'An unexpected error occurred',
        request_id: requestId,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Codes that mean the database (or the pooler in front of it) could not be reached or refused the
 * connection, not that the request or our code was wrong: Postgres "too many connections" and
 * shutdown classes, connection-exception class 08, and what the driver and the socket report.
 */
const DATABASE_UNAVAILABLE_CODES = new Set([
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** Normalizes any thrown value into an AppError. */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  // A database that cannot be reached is the platform's problem, not a bug in this request: say so
  // (503, try again) so a client does not mistake it for a failure of its own and the next
  // reader of the logs sees an outage rather than a crash.
  const code = pgErrorCode(value);
  if (code !== undefined && DATABASE_UNAVAILABLE_CODES.has(code)) {
    return new AppError('UPSTREAM_UNAVAILABLE', 'The service is temporarily unavailable. Please try again shortly.', { cause: value });
  }
  const message = value instanceof Error ? value.message : String(value);
  return new AppError('INTERNAL_ERROR', message, { cause: value, exposeMessage: false });
}

export function statusCodeFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * Postgres error codes (e.g. unique_violation `23505`) for conflict-detection
 * `catch` blocks across the repo. `postgres`/drizzle-orm wrap the raw driver
 * error in their own error class and move it to `.cause` rather than
 * throwing it directly, so a plain `(cause as { code }).code` check silently
 * misses it — check one level of `.cause` unwrapping too.
 */
export function pgErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const direct = (cause as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  return pgErrorCode((cause as { cause?: unknown }).cause);
}
