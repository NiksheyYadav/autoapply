import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@atlas/utils';
import { createStorage, storageOptionsFromEnv, type StorageEnv } from '../src/index.js';
import { createSupabaseDriver } from '../src/supabase-driver.js';

const URL_BASE = 'https://proj.supabase.co';
const SECRET = 'sb_secret_do_not_leak';

interface Call {
  url: string;
  init: RequestInit;
}

function harness(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  });
  const driver = createSupabaseDriver({
    url: `${URL_BASE}/`,
    secretKey: SECRET,
    bucket: 'resumes',
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { driver, calls };
}

const header = (call: Call, name: string): string | undefined =>
  (call.init.headers as Record<string, string> | undefined)?.[name];

describe('supabase storage driver', () => {
  it('uploads with POST, upsert and the content type, authenticating with the secret key', async () => {
    const { driver, calls } = harness(() => new Response('{"Key":"resumes/x"}', { status: 200 }));
    const data = Buffer.from('%PDF-1.7 resume');
    await expect(driver.put('resumes/user-1/abc', data, { contentType: 'application/pdf' })).resolves.toEqual({
      key: 'resumes/user-1/abc',
      byteSize: data.length,
    });

    const [call] = calls;
    expect(call?.url).toBe(`${URL_BASE}/storage/v1/object/resumes/resumes/user-1/abc`);
    expect(call?.init.method).toBe('POST');
    expect(header(call as Call, 'x-upsert')).toBe('true');
    expect(header(call as Call, 'content-type')).toBe('application/pdf');
    expect(header(call as Call, 'authorization')).toBe(`Bearer ${SECRET}`);
    expect(header(call as Call, 'apikey')).toBe(SECRET);
    expect(Buffer.from(call?.init.body as Uint8Array).equals(data)).toBe(true);
  });

  it('defaults the content type and percent-encodes each path segment', async () => {
    const { driver, calls } = harness(() => new Response('{}', { status: 200 }));
    await driver.put('a b/ü?#.txt', Buffer.from('x'));
    expect(calls[0]?.url).toBe(`${URL_BASE}/storage/v1/object/resumes/a%20b/%C3%BC%3F%23.txt`);
    expect(header(calls[0] as Call, 'content-type')).toBe('application/octet-stream');
  });

  it('downloads the bytes with GET', async () => {
    const { driver, calls } = harness(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    await expect(driver.get('k')).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(calls[0]?.init.method).toBe('GET');
    expect(header(calls[0] as Call, 'authorization')).toBe(`Bearer ${SECRET}`);
  });

  it.each([
    ['404', new Response('{"error":"not_found"}', { status: 404 })],
    ['400 not_found', new Response('{"statusCode":"404","error":"not_found","message":"Object not found"}', { status: 400 })],
  ])('maps a missing object (%s) to NOT_FOUND on get', async (_label, response) => {
    const { driver } = harness(() => response.clone());
    await expect(driver.get('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not mistake other failures for a missing object', async () => {
    const { driver } = harness(() => new Response('boom', { status: 500 }));
    await expect(driver.get('k')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('deletes through the bucket endpoint with a prefixes body, and treats an already-missing object as done', async () => {
    const ok = harness(() => new Response('[]', { status: 200 }));
    await expect(ok.driver.delete('a/b')).resolves.toBeUndefined();
    expect(ok.calls[0]?.url).toBe(`${URL_BASE}/storage/v1/object/resumes`);
    expect(ok.calls[0]?.init.method).toBe('DELETE');
    expect(JSON.parse(ok.calls[0]?.init.body as string)).toEqual({ prefixes: ['a/b'] });

    const gone = harness(() => new Response('{"error":"not_found"}', { status: 404 }));
    await expect(gone.driver.delete('a/b')).resolves.toBeUndefined();

    const broken = harness(() => new Response('nope', { status: 500 }));
    await expect(broken.driver.delete('a/b')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('checks existence with HEAD: 200 is true, 400/404 are false, anything else throws', async () => {
    await expect(harness(() => new Response(null, { status: 200 })).driver.exists('k')).resolves.toBe(true);
    await expect(harness(() => new Response(null, { status: 404 })).driver.exists('k')).resolves.toBe(false);
    await expect(harness(() => new Response(null, { status: 400 })).driver.exists('k')).resolves.toBe(false);
    await expect(harness(() => new Response(null, { status: 503 })).driver.exists('k')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    const head = harness(() => new Response(null, { status: 200 }));
    await head.driver.exists('k');
    expect(head.calls[0]?.init.method).toBe('HEAD');
  });

  it.each(['', '/abs', 'trailing/', 'a//b', '../escape', 'a/../b', 'a/./b', 'a\\b', 'nul\0byte'])(
    'rejects the unsafe key %j before making any request',
    async (key) => {
      const { driver, calls } = harness(() => new Response('{}', { status: 200 }));
      await expect(driver.put(key, Buffer.from('x'))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(driver.get(key)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(driver.delete(key)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(driver.exists(key)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(calls).toHaveLength(0);
    },
  );

  it('reports a network failure as UPSTREAM_UNAVAILABLE without leaking the secret or URL', async () => {
    const { driver } = harness(() => {
      throw new TypeError(`fetch failed for ${URL_BASE} with ${SECRET}`);
    });
    const error = await driver.put('k', Buffer.from('x')).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('UPSTREAM_UNAVAILABLE');
    expect((error as AppError).message).not.toContain(SECRET);
    expect((error as AppError).message).not.toContain(URL_BASE);
  });

  it('keeps the upstream error body out of the public message', async () => {
    const { driver } = harness(() => new Response(`bucket policy says ${SECRET}`, { status: 403 }));
    const error = (await driver.put('k', Buffer.from('x')).catch((cause: unknown) => cause)) as AppError;
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).not.toContain('bucket policy');
  });

  it('gives up on a hung request instead of waiting for the platform to kill the function', async () => {
    const driver = createSupabaseDriver({
      url: URL_BASE,
      secretKey: SECRET,
      bucket: 'resumes',
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })) as unknown as typeof fetch,
    });
    await expect(driver.get('k')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

describe('createStorage / storageOptionsFromEnv', () => {
  const base: StorageEnv = { STORAGE_DRIVER: 'local', STORAGE_LOCAL_ROOT: './.atlas-storage' };

  it('builds the supabase driver only when fully configured', () => {
    expect(() => createStorage({ driver: 'supabase', supabaseUrl: URL_BASE })).toThrow(/SUPABASE_SECRET_KEY/);
    expect(() =>
      createStorage({ driver: 'supabase', supabaseUrl: URL_BASE, supabaseSecretKey: SECRET, supabaseBucket: 'resumes' }),
    ).not.toThrow();
  });

  it('passes the supabase settings through', () => {
    const { options, warning } = storageOptionsFromEnv({
      ...base,
      STORAGE_DRIVER: 'supabase',
      SUPABASE_URL: URL_BASE,
      SUPABASE_SECRET_KEY: SECRET,
      SUPABASE_STORAGE_BUCKET: 'resumes',
    });
    expect(options).toEqual({
      driver: 'supabase',
      supabaseUrl: URL_BASE,
      supabaseSecretKey: SECRET,
      supabaseBucket: 'resumes',
    });
    expect(warning).toBeUndefined();
  });

  it('keeps the configured local root outside serverless', () => {
    const { options, warning } = storageOptionsFromEnv(base);
    expect(options).toMatchObject({ driver: 'local', localRoot: './.atlas-storage' });
    expect(warning).toBeUndefined();
  });

  it('moves a local driver to writable temp storage on serverless, and says it is ephemeral', () => {
    const { options, warning } = storageOptionsFromEnv(base, { serverless: true });
    expect(options.driver).toBe('local');
    expect(options.localRoot).not.toBe('./.atlas-storage');
    expect(options.localRoot).toMatch(/atlas-storage$/);
    expect(warning).toMatch(/ephemeral/);
  });
});
