export interface ApiErrorOptions {
  /** The `request_id` of the docs/04 error envelope, useful to quote when asking for support. */
  requestId?: string;
  /** The envelope's `details` (e.g. `{ max_rows }`). Untrusted: validate before use. */
  details?: unknown;
  /** From the `Retry-After` header of a 429. */
  retryAfterSeconds?: number;
}

export class ApiError extends Error {
  readonly requestId: string | undefined;
  readonly details: unknown;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.requestId = options.requestId;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Status 0 stands for "no HTTP response at all" (offline, DNS, CORS, aborted by the network). */
export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';
/** A 2xx response whose body did not match the shared contract. */
export const INVALID_RESPONSE_CODE = 'INVALID_RESPONSE';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON body. Mutually exclusive with `rawBody`. */
  body?: unknown;
  /** A body sent as-is (e.g. a CSV `File`); set the content type via `headers`. */
  rawBody?: BodyInit;
  accessToken?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_SERVER_MESSAGE_LENGTH = 300;

/** `Retry-After` as whole seconds (the rate limiter sends seconds), or undefined. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return undefined;
  return Math.min(Number(trimmed), 3600);
}

function fallbackCode(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'VALIDATION_ERROR';
}

/**
 * Builds an {@link ApiError} from a non-2xx response. The body is optional and
 * untrusted: a gateway failure can answer with an HTML page, an empty body, or
 * anything else, and none of that may turn into an unhandled exception.
 */
export function apiErrorFromResponse(status: number, headers: Headers, bodyText: string): ApiError {
  let envelope: unknown;
  try {
    envelope = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
  } catch {
    envelope = undefined;
  }
  const error = isRecord(envelope) && isRecord(envelope.error) ? envelope.error : undefined;

  const code = typeof error?.code === 'string' ? error.code : fallbackCode(status);
  const message =
    typeof error?.message === 'string' && error.message.length > 0
      ? error.message.slice(0, MAX_SERVER_MESSAGE_LENGTH)
      : `Request failed with status ${status}`;

  return new ApiError(status, code, message, {
    requestId: typeof error?.request_id === 'string' ? error.request_id : undefined,
    details: error?.details,
    retryAfterSeconds: parseRetryAfter(headers.get('retry-after')),
  });
}

/** A token for the next request, or a 401 {@link ApiError} (so the UI offers "Sign in") when the session is gone. */
export async function requireAccessToken(getAccessToken: () => Promise<string | null>): Promise<string> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'No active session');
  return token;
}

async function send(baseUrl: string, path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  let body: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;

  try {
    return await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: options.signal,
      // Bearer-token API: never send ambient cookies, never reuse a stored
      // response (the admin API marks everything no-store; this keeps the
      // browser from second-guessing it), never leak the page URL as a referrer.
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, NETWORK_ERROR_CODE, 'The request did not reach the server');
  }
}

/** JSON in, JSON out; a non-2xx answer surfaces as an {@link ApiError}. Also returns the response headers. */
export async function apiRequest<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const res = await send(baseUrl, path, options);
  const text = await res.text();

  if (!res.ok) throw apiErrorFromResponse(res.status, res.headers, text);
  if (res.status === 204 || text.length === 0) {
    return { status: res.status, data: undefined as T, headers: res.headers };
  }

  try {
    return { status: res.status, data: JSON.parse(text) as T, headers: res.headers };
  } catch {
    throw new ApiError(res.status, INVALID_RESPONSE_CODE, 'The response was not valid JSON');
  }
}

/** Shared fetch wrapper: JSON in, JSON out, and the docs/04 error envelope surfaces as an ApiError. */
export async function apiFetch<T>(baseUrl: string, path: string, options: RequestOptions = {}): Promise<T> {
  return (await apiRequest<T>(baseUrl, path, options)).data;
}

/** For file downloads: the body is returned as a Blob, errors are still parsed from the JSON envelope. */
export async function apiFetchBlob(
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<{ blob: Blob; headers: Headers }> {
  const res = await send(baseUrl, path, options);
  if (!res.ok) throw apiErrorFromResponse(res.status, res.headers, await res.text());
  return { blob: await res.blob(), headers: res.headers };
}
