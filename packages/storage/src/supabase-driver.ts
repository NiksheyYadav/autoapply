import { AppError } from '@atlas/utils';
import type { PutOptions, PutResult, StorageDriver } from './driver.js';

export interface SupabaseDriverOptions {
  /** Project URL, e.g. `https://<ref>.supabase.co` (no trailing path). */
  url: string;
  /**
   * Server-side secret: the `sb_secret_…` key, or the legacy `service_role`
   * JWT. It bypasses Row Level Security, so it must only ever live in a
   * backend service's environment — never in client code, logs or errors.
   */
  secretKey: string;
  /** An existing, PRIVATE bucket. */
  bucket: string;
  /** Per-request timeout. Defaults to 20 s, well inside a 30 s serverless budget. */
  timeoutMs?: number;
  /** Injection point for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Enough of a Storage error body to be useful in logs without echoing an arbitrarily large response. */
const MAX_ERROR_BODY_CHARS = 300;

/**
 * Splits a key into path segments and rejects anything that is not a plain,
 * relative object path. Storage treats `..` literally rather than resolving
 * it, but a key that looks like traversal is always a bug (or an attack) on
 * our side, and the local driver rejects the same inputs.
 */
function toObjectPath(key: string): string {
  if (!key || key.includes('\0') || key.includes('\\') || key.startsWith('/') || key.endsWith('/')) {
    throw new AppError('VALIDATION_ERROR', `Invalid storage key: "${key}"`);
  }
  const segments = key.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new AppError('VALIDATION_ERROR', `Invalid storage key: "${key}"`);
  }
  return segments.map(encodeURIComponent).join('/');
}

async function describeFailure(response: Response): Promise<string> {
  let body = '';
  try {
    body = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    // The status alone is still informative.
  }
  return body ? `${response.status} ${body}` : String(response.status);
}

/**
 * Storage over Supabase Storage's REST API, via `fetch` so the serverless
 * bundle carries no SDK. Endpoints match `@supabase/storage-js`:
 *   POST   /storage/v1/object/{bucket}/{key}   (x-upsert: true)
 *   GET    /storage/v1/object/{bucket}/{key}   (private bucket: needs the key)
 *   HEAD   /storage/v1/object/{bucket}/{key}
 *   DELETE /storage/v1/object/{bucket}         ({ prefixes: [key] })
 *
 * Uploads are keyed by content hash upstream, so upserting is idempotent.
 */
export function createSupabaseDriver(options: SupabaseDriverOptions): StorageDriver {
  const base = `${options.url.replace(/\/+$/, '')}/storage/v1/object`;
  const bucket = encodeURIComponent(options.bucket);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authHeaders = { authorization: `Bearer ${options.secretKey}`, apikey: options.secretKey };

  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      // Network failure or timeout. The message deliberately omits the URL and headers.
      throw new AppError('UPSTREAM_UNAVAILABLE', 'File storage is temporarily unavailable', { cause });
    }
  }

  /** Storage answers a missing object with 404, or 400 + `not_found` depending on the version. */
  async function isMissing(response: Response): Promise<boolean> {
    if (response.status === 404) return true;
    if (response.status !== 400) return false;
    const body = await response.clone().text().catch(() => '');
    return /not[_ ]found/i.test(body);
  }

  return {
    async put(key: string, data: Buffer, putOptions?: PutOptions): Promise<PutResult> {
      const path = toObjectPath(key);
      const response = await request(`${base}/${bucket}/${path}`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': putOptions?.contentType ?? 'application/octet-stream',
          'x-upsert': 'true',
        },
        body: new Uint8Array(data),
      });
      if (!response.ok) {
        throw new AppError('UPSTREAM_UNAVAILABLE', 'File storage rejected the upload', {
          cause: new Error(`Supabase Storage upload failed: ${await describeFailure(response)}`),
        });
      }
      return { key, byteSize: data.length };
    },

    async get(key: string): Promise<Buffer> {
      const path = toObjectPath(key);
      const response = await request(`${base}/${bucket}/${path}`, { method: 'GET', headers: authHeaders });
      if (await isMissing(response)) {
        throw new AppError('NOT_FOUND', `No stored object for key "${key}"`);
      }
      if (!response.ok) {
        throw new AppError('UPSTREAM_UNAVAILABLE', 'File storage could not read the file', {
          cause: new Error(`Supabase Storage GET failed: ${await describeFailure(response)}`),
        });
      }
      return Buffer.from(await response.arrayBuffer());
    },

    async delete(key: string): Promise<void> {
      toObjectPath(key); // same validation as every other operation
      const response = await request(`${base}/${bucket}`, {
        method: 'DELETE',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: [key] }),
      });
      // Deleting something that is already gone is a no-op, as in the local driver.
      if (!response.ok && !(await isMissing(response))) {
        throw new AppError('UPSTREAM_UNAVAILABLE', 'File storage could not delete the file', {
          cause: new Error(`Supabase Storage DELETE failed: ${await describeFailure(response)}`),
        });
      }
    },

    async exists(key: string): Promise<boolean> {
      const path = toObjectPath(key);
      const response = await request(`${base}/${bucket}/${path}`, { method: 'HEAD', headers: authHeaders });
      if (response.ok) return true;
      // HEAD responses carry no body, so 400 and 404 both mean "not there" (as storage-js treats them).
      if (response.status === 404 || response.status === 400) return false;
      throw new AppError('UPSTREAM_UNAVAILABLE', 'File storage could not check the file', {
        cause: new Error(`Supabase Storage HEAD failed: ${response.status}`),
      });
    },
  };
}
