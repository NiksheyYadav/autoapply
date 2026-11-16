import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { JOB_BOARD_PROVIDERS, BOARD_TOKEN_PATTERN, upsertJobBoardSourceRequestSchema } from '@atlas/types';
import {
  buildUserAgent,
  fetchSourcePostings,
  SourceFetchError,
  type FetchSourceOptions,
} from '../src/lib/job-sources/fetch-source.js';
import { buildSourceUrl, InvalidBoardTokenError, PROVIDER_ADAPTERS } from '../src/lib/job-sources/providers.js';

// No test here touches the network: `fetch` is always an injected stub.
function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

type FetchStub = ReturnType<typeof vi.fn<typeof fetch>>;

function stubFetch(respond: (url: URL, init: RequestInit) => Response | Promise<Response>): FetchStub {
  return vi.fn<typeof fetch>(async (input, init) => respond(input as URL, init ?? {}));
}

function options(fetchImpl: typeof fetch, overrides: Partial<FetchSourceOptions> = {}): FetchSourceOptions {
  return { fetch: fetchImpl, userAgent: 'AtlasJobIngest/test', timeoutMs: 2_000, maxBytes: 5_000_000, ...overrides };
}

const json = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });

async function failure(promise: Promise<unknown>): Promise<SourceFetchError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SourceFetchError);
  return error as SourceFetchError;
}

describe('request URLs', () => {
  it('are the documented endpoints on the providers\' fixed hosts', () => {
    expect(buildSourceUrl('greenhouse', 'figma').href).toBe('https://boards-api.greenhouse.io/v1/boards/figma/jobs?content=true');
    expect(buildSourceUrl('lever', 'leverdemo').href).toBe('https://api.lever.co/v0/postings/leverdemo?mode=json');
    expect(buildSourceUrl('ashby', 'Ashby').href).toBe('https://api.ashbyhq.com/posting-api/job-board/Ashby');
  });

  it('can only ever point at the provider\'s own origin, whatever token is accepted', () => {
    const tokens = ['a', 'Z9', 'under_score', 'hy-phen', 'x'.repeat(100), '0123456789'];
    for (const provider of JOB_BOARD_PROVIDERS) {
      for (const token of tokens) {
        const url = buildSourceUrl(provider, token);
        expect(url.origin).toBe(PROVIDER_ADAPTERS[provider].origin);
        expect(url.protocol).toBe('https:');
        expect(url.username + url.password + url.hash).toBe('');
        expect(url.port).toBe('');
        // The token is the last path segment, whole.
        expect(url.pathname.endsWith(`/${token}`) || url.pathname.endsWith(`/${token}/jobs`)).toBe(true);
      }
    }
  });
});

describe('board token validation (SSRF)', () => {
  const hostile = [
    ['a path traversal', '../admin'],
    ['a bare double dot', '..'],
    ['a dotted hostname', 'evil.example.com'],
    ['an IPv4 address', '127.0.0.1'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['userinfo that would repoint the host', 'good@evil.example'],
    ['a port', 'host:8080'],
    ['a query string', 'a?x=1'],
    ['a fragment', 'a#frag'],
    ['an encoded dot', '%2e%2e'],
    ['an encoded slash', 'a%2fb'],
    ['whitespace', 'a b'],
    ['a trailing newline', 'abc\n'],
    ['a leading hyphen', '-abc'],
    ['an underscore start', '_abc'],
    ['non-ASCII letters', 'café'],
    ['an empty string', ''],
    ['an overlong token', 'a'.repeat(101)],
  ] as const;

  it.each(hostile)('refuses %s before any request is made', async (_label, token) => {
    expect(BOARD_TOKEN_PATTERN.test(token)).toBe(false);
    for (const provider of JOB_BOARD_PROVIDERS) {
      expect(() => buildSourceUrl(provider, token)).toThrow(InvalidBoardTokenError);

      const fetchStub = stubFetch(() => json('[]'));
      const error = await failure(
        fetchSourcePostings({ provider, boardToken: token, companyName: 'Acme' }, options(fetchStub)),
      );
      expect(error.code).toBe('invalid_token');
      expect(fetchStub).not.toHaveBeenCalled();
    }
  });

  it.each(hostile)('is also refused at the API boundary: %s', (_label, token) => {
    const parsed = upsertJobBoardSourceRequestSchema.safeParse({ provider: 'greenhouse', board_token: token, company_name: 'Acme' });
    expect(parsed.success).toBe(false);
  });

  it('accepts ordinary tokens at the API boundary, and trims the company name', () => {
    const parsed = upsertJobBoardSourceRequestSchema.parse({
      provider: 'lever',
      board_token: 'my-company_2',
      company_name: '  Acme Corp  ',
    });
    expect(parsed).toEqual({ provider: 'lever', board_token: 'my-company_2', company_name: 'Acme Corp' });
  });

  it.each([[''], ['   '], ['bad\u0000name'], ['two\nlines'], ['x'.repeat(301)]])(
    'refuses the company name %j at the API boundary',
    (companyName) => {
      expect(
        upsertJobBoardSourceRequestSchema.safeParse({ provider: 'lever', board_token: 'acme', company_name: companyName }).success,
      ).toBe(false);
    },
  );
});

describe('fetchSourcePostings', () => {
  const greenhouse = { provider: 'greenhouse', boardToken: 'figma', companyName: 'Figma' } as const;

  it('makes one read-only GET with an identifying User-Agent and no credentials', async () => {
    const fetchStub = stubFetch(() => json(fixtureText('greenhouse-jobs-content.json')));
    const result = await fetchSourcePostings(greenhouse, options(fetchStub, { userAgent: 'AtlasJobIngest/1.0 (+test)' }));

    expect(result.postings).toHaveLength(2);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(String(url)).toBe('https://boards-api.greenhouse.io/v1/boards/figma/jobs?content=true');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    // A redirect could leave the provider's host; these endpoints answer directly.
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe('AtlasJobIngest/1.0 (+test)');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect([...headers.keys()].sort()).toEqual(['accept', 'user-agent']);
    expect(init?.credentials).toBeUndefined();
  });

  it('reads Lever and Ashby through the same path', async () => {
    const lever = await fetchSourcePostings(
      { provider: 'lever', boardToken: 'leverdemo', companyName: 'Lever Demo' },
      options(stubFetch(() => json(fixtureText('lever-postings.json')))),
    );
    expect(lever.postings).toHaveLength(3);

    const ashby = await fetchSourcePostings(
      { provider: 'ashby', boardToken: 'ashby', companyName: 'Ashby' },
      options(stubFetch(() => json(fixtureText('ashby-job-board.json')))),
    );
    expect(ashby.postings).toHaveLength(2);
  });

  it.each([
    [404, /404.*board not found/],
    [429, /429.*rate limited/],
    [500, /500.*server error/],
    [503, /503.*server error/],
    [403, /403.*refused/],
  ])('reports HTTP %i with a fixed message', async (status, message) => {
    const error = await failure(
      fetchSourcePostings(greenhouse, options(stubFetch(() => new Response('whatever', { status })))),
    );
    expect(error.code).toBe('http');
    expect(error.message).toMatch(message);
  });

  it('never echoes the upstream body or a transport error\'s text', async () => {
    const leaky = 'secret-looking-value-12345 at /srv/internal/path postgres://user:pw@host/db';
    const fromBody = await failure(fetchSourcePostings(greenhouse, options(stubFetch(() => new Response(leaky, { status: 500 })))));
    expect(fromBody.message).not.toContain('secret-looking');

    const fromHtml = await failure(fetchSourcePostings(greenhouse, options(stubFetch(() => json(`<html>${leaky}</html>`)))));
    expect(fromHtml.code).toBe('invalid_json');
    expect(fromHtml.message).not.toContain('secret-looking');

    const fromThrow = await failure(
      fetchSourcePostings(
        greenhouse,
        options(
          stubFetch(() => {
            throw new TypeError(leaky, { cause: { code: 'ECONNRESET', message: leaky } });
          }),
        ),
      ),
    );
    expect(fromThrow.code).toBe('network');
    expect(fromThrow.message).toBe('network error (ECONNRESET)');
  });

  it('reports a transport failure without a code as a plain network error', async () => {
    const error = await failure(
      fetchSourcePostings(greenhouse, options(stubFetch(() => Promise.reject(new TypeError('fetch failed'))))),
    );
    expect(error).toMatchObject({ code: 'network', message: 'network error' });
  });

  it('gives up after the timeout when the request hangs', async () => {
    const hangs = stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const started = performance.now();
    const error = await failure(fetchSourcePostings(greenhouse, options(hangs, { timeoutMs: 60 })));
    expect(error.code).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('enforces the timeout even for a fetch that ignores the abort signal', async () => {
    const ignoresSignal = stubFetch(() => new Promise<Response>(() => undefined));
    const started = performance.now();
    const error = await failure(fetchSourcePostings(greenhouse, options(ignoresSignal, { timeoutMs: 60 })));
    expect(error.code).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('enforces the timeout while the body is still streaming', async () => {
    const stalls = stubFetch((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jobs": ['));
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200 });
    });
    const error = await failure(fetchSourcePostings(greenhouse, options(stalls, { timeoutMs: 60 })));
    expect(error.code).toBe('timeout');
  });

  it('refuses a response larger than the limit, by header and by actual size', async () => {
    const declared = await failure(
      fetchSourcePostings(
        greenhouse,
        options(stubFetch(() => json('{"jobs":[]}', { headers: { 'content-length': '999999' } })), { maxBytes: 1_000 }),
      ),
    );
    expect(declared.code).toBe('too_large');

    const big = JSON.stringify({ jobs: [], padding: 'x'.repeat(5_000) });
    const streamed = await failure(fetchSourcePostings(greenhouse, options(stubFetch(() => json(big)), { maxBytes: 1_000 })));
    expect(streamed.code).toBe('too_large');

    // At the limit is fine.
    const ok = await fetchSourcePostings(greenhouse, options(stubFetch(() => json(big)), { maxBytes: big.length }));
    expect(ok.postings).toEqual([]);
  });

  it('reports a body that is not JSON, and JSON of the wrong shape', async () => {
    expect((await failure(fetchSourcePostings(greenhouse, options(stubFetch(() => json('<!doctype html>')))))).code).toBe('invalid_json');
    expect((await failure(fetchSourcePostings(greenhouse, options(stubFetch(() => json('')))))).code).toBe('invalid_json');

    const wrong = await failure(fetchSourcePostings(greenhouse, options(stubFetch(() => json('{"error":"nope"}')))));
    expect(wrong).toMatchObject({ code: 'bad_payload', message: 'Greenhouse response has no "jobs" array' });
  });

  it('treats an empty board as a success with no postings', async () => {
    const result = await fetchSourcePostings(greenhouse, options(stubFetch(() => json('{"jobs":[],"meta":{"total":0}}'))));
    expect(result).toEqual({ postings: [], skipped: 0 });
  });
});

describe('buildUserAgent', () => {
  it('names the product and says it only reads', () => {
    expect(buildUserAgent()).toMatch(/^AtlasJobIngest\/\d/);
    expect(buildUserAgent()).toContain('read-only');
  });

  it('includes a contact when one is configured', () => {
    expect(buildUserAgent('jobs-ingest@example.com')).toContain('contact: jobs-ingest@example.com');
  });

  it.each([[''], ['   '], ['line\r\nX-Injected: 1'], ['café'], ['x'.repeat(201)]])(
    'ignores a contact that is unusable in a header: %j',
    (contact) => {
      expect(buildUserAgent(contact)).toBe(buildUserAgent());
    },
  );
});
