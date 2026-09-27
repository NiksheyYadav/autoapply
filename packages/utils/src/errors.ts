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

/** Normalizes any thrown value into an AppError. */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
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
