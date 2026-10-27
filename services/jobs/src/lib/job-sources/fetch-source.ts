import type { JobBoardProvider } from '@atlas/types';
import { SourcePayloadError, type MappedJobs } from './common.js';
import { buildSourceUrl, InvalidBoardTokenError, PROVIDER_ADAPTERS } from './providers.js';

export type SourceFetchErrorCode =
  | 'invalid_token'
  | 'timeout'
  | 'network'
  | 'http'
  | 'too_large'
  | 'invalid_json'
  | 'bad_payload';

/**
 * Why a source could not be read. The message is written here, never copied
 * from the upstream response or from a driver error, so it is safe to store in
 * `job_sources.last_error` and to return from the API as is.
 */
export class SourceFetchError extends Error {
  readonly code: SourceFetchErrorCode;
  constructor(code: SourceFetchErrorCode, message: string) {
    super(message);
    this.name = 'SourceFetchError';
    this.code = code;
  }
}

export interface FetchSourceOptions {
  /** Injected so tests never touch the network; production passes the global `fetch`. */
  fetch: typeof fetch;
  userAgent: string;
  /** Covers the request and reading the body. */
  timeoutMs: number;
  /** Upper bound on the response body. */
  maxBytes: number;
}

export interface SourceToFetch {
  provider: JobBoardProvider;
  boardToken: string;
  companyName: string;
}

export const DEFAULT_SOURCE_TIMEOUT_MS = 10_000;
/** A board of ~900 postings with full descriptions is roughly 11 MB (Databricks, 2026-10). */
export const DEFAULT_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

const PRODUCT = 'AtlasJobIngest/1.0';

/**
 * Identifies this reader to the employers' job-board hosts. `contact` (an
 * email address or URL the operator controls) is optional and printable ASCII
 * only, so it cannot inject another header line.
 */
export function buildUserAgent(contact?: string | null): string {
  const trimmed = contact?.trim();
  const printable = trimmed !== undefined && trimmed !== '' && /^[\x20-\x7e]{1,200}$/.test(trimmed);
  return printable
    ? `${PRODUCT} (+read-only public job board reader; contact: ${trimmed})`
    : `${PRODUCT} (+read-only public job board reader)`;
}

function describeHttpFailure(status: number): string {
  if (status === 404) return 'HTTP 404: board not found (check the provider and board token)';
  if (status === 429) return 'HTTP 429: the provider rate limited this request';
  if (status >= 500) return `HTTP ${status}: the provider reported a server error`;
  return `HTTP ${status}: the provider refused the request`;
}

/** A short, fixed description of a thrown transport failure; the raw error text is not kept. */
function describeNetworkFailure(error: unknown): string {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{3,40}$/.test(code)
    ? `network error (${code})`
    : 'network error';
}

function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceFetchError('too_large', 'response is larger than the size limit');
  }
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SourceFetchError('too_large', 'response is larger than the size limit');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Reads one board: a single GET to the provider's public endpoint, mapped to
 * postings. Read-only; sends no credentials of any kind. Redirects are refused
 * (these endpoints answer directly, and following one could leave the
 * provider's host). Every failure is a {@link SourceFetchError} with a fixed,
 * short message; nothing from the response body is echoed.
 */
export async function fetchSourcePostings(
  source: SourceToFetch,
  options: FetchSourceOptions,
): Promise<MappedJobs> {
  let url: URL;
  try {
    url = buildSourceUrl(source.provider, source.boardToken);
  } catch (error) {
    if (error instanceof InvalidBoardTokenError) {
      throw new SourceFetchError('invalid_token', 'board token is not a valid identifier');
    }
    throw error;
  }

  const signal = AbortSignal.timeout(options.timeoutMs);
  // `fetch` honours the signal, but the deadline must hold even for a caller-supplied
  // implementation that does not, so the request is also raced against it.
  const deadline = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  let body: string;
  try {
    body = await Promise.race([
      deadline,
      (async () => {
        const response = await options.fetch(url, {
          method: 'GET',
          redirect: 'error',
          headers: { 'user-agent': options.userAgent, accept: 'application/json' },
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new SourceFetchError('http', describeHttpFailure(response.status));
        }
        return await readBody(response, options.maxBytes);
      })(),
    ]);
  } catch (error) {
    if (error instanceof SourceFetchError) throw error;
    if (isAbort(error)) {
      throw new SourceFetchError('timeout', `no complete response within ${Math.ceil(options.timeoutMs / 1000)}s`);
    }
    throw new SourceFetchError('network', describeNetworkFailure(error));
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new SourceFetchError('invalid_json', 'response is not valid JSON');
  }

  try {
    return PROVIDER_ADAPTERS[source.provider].map(payload, { companyName: source.companyName });
  } catch (error) {
    if (error instanceof SourcePayloadError) throw new SourceFetchError('bad_payload', error.message);
    throw error;
  }
}
