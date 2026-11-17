import {
  SignJWT,
  base64url,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@atlas/utils';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const SUB = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JWK;
let publicPem: string;

/** What the stubbed JWKS endpoint does on the next fetch. */
let jwksBehavior: () => Promise<Response>;
const serveKeys = () =>
  Promise.resolve(
    new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

vi.stubGlobal('fetch', () => jwksBehavior());

const { createTokenVerifierConfig, verifyAccessToken } = await import('../src/tokens.js');

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair('ES256')).privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'good-key', alg: 'ES256', use: 'sig' };
  publicPem = await exportSPKI(pair.publicKey);
});

beforeEach(() => {
  jwksBehavior = serveKeys;
});

interface Options {
  key?: CryptoKey;
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  omit?: string[];
  exp?: number | null;
  nbf?: number;
}

async function token(options: Options = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    session_id: SESSION,
    email: 'ada@example.com',
    app_metadata: {},
    ...options.payload,
  };
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: 'good-key', ...options.header })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt();
  if (!options.omit?.includes('sub')) jwt.setSubject(SUB);
  if (options.exp !== null) jwt.setExpirationTime(options.exp ?? now + 900);
  if (options.nbf !== undefined) jwt.setNotBefore(options.nbf);
  return jwt.sign(options.key ?? signingKey);
}

function verify(jwt: string) {
  // A fresh config each time: it holds the JWKS cache.
  return verifyAccessToken(jwt, createTokenVerifierConfig({ SUPABASE_URL }));
}

async function status(jwt: string): Promise<{ code: string; httpStatus: number } | 'accepted'> {
  try {
    await verify(jwt);
    return 'accepted';
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, httpStatus: error.statusCode };
    throw error;
  }
}

const rejected = { code: 'UNAUTHENTICATED', httpStatus: 401 };

describe('forged and tampered tokens are all refused as unauthenticated', () => {
  it('accepts a correctly signed token (the control for everything below)', async () => {
    expect(await status(await token())).toBe('accepted');
  });

  it('refuses alg "none", with and without a signature part', async () => {
    const header = base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const body = base64url.encode(
      JSON.stringify({
        sub: SUB,
        session_id: SESSION,
        email: 'ada@example.com',
        iss: ISSUER,
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 900,
        app_metadata: { role: 'owner', org_id: ORG },
      }),
    );
    expect(await status(`${header}.${body}.`)).toEqual(rejected);
    expect(await status(`${header}.${body}`)).toEqual(rejected);
    expect(await status(`${header}.${body}.AAAA`)).toEqual(rejected);
  });

  it('refuses an HS256 token whose secret is the public key (algorithm confusion)', async () => {
    const claims = { session_id: SESSION, email: 'ada@example.com', app_metadata: { role: 'owner', org_id: ORG } };
    for (const secret of [publicPem, JSON.stringify(publicJwk), String(publicJwk.x) + String(publicJwk.y)]) {
      const forged = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', kid: 'good-key' })
        .setSubject(SUB)
        .setIssuer(ISSUER)
        .setAudience('authenticated')
        .setExpirationTime('15m')
        .sign(new TextEncoder().encode(secret));
      expect(await status(forged)).toEqual(rejected);
    }
  });

  it('refuses a token signed by another key, whatever kid it claims', async () => {
    expect(await status(await token({ key: otherKey }))).toEqual(rejected);
    expect(await status(await token({ key: otherKey, header: { kid: 'unknown-key' } }))).toEqual(rejected);
    expect(await status(await token({ key: otherKey, header: { kid: undefined } }))).toEqual(rejected);
  });

  it('refuses a token carrying its own key in the header (jwk) or a key URL (jku, x5u)', async () => {
    const attackerPublic = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)) };
    expect(await status(await token({ key: otherKey, header: { jwk: attackerPublic } }))).toEqual(rejected);
    expect(
      await status(await token({ key: otherKey, header: { jku: 'https://evil.example/jwks.json' } })),
    ).toEqual(rejected);
    expect(await status(await token({ key: otherKey, header: { x5u: 'https://evil.example/cert.pem' } }))).toEqual(
      rejected,
    );
  });

  it('refuses a payload swapped under a valid signature', async () => {
    const [header, , signature] = (await token()).split('.');
    const swapped = base64url.encode(
      JSON.stringify({
        sub: SUB,
        session_id: SESSION,
        email: 'ada@example.com',
        iss: ISSUER,
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 900,
        app_metadata: { role: 'owner', org_id: ORG },
      }),
    );
    expect(await status(`${header}.${swapped}.${signature}`)).toEqual(rejected);
  });

  it('refuses wrong issuer, wrong audience (string and array), and a token that is not yet valid', async () => {
    const now = Math.floor(Date.now() / 1000);
    const custom = (overrides: (jwt: SignJWT) => SignJWT) =>
      overrides(
        new SignJWT({ session_id: SESSION, email: 'ada@example.com', app_metadata: {} })
          .setProtectedHeader({ alg: 'ES256', kid: 'good-key' })
          .setSubject(SUB)
          .setExpirationTime(now + 900),
      ).sign(signingKey);

    expect(await status(await custom((jwt) => jwt.setIssuer('https://evil.example/auth/v1').setAudience('authenticated')))).toEqual(rejected);
    expect(await status(await custom((jwt) => jwt.setIssuer(`${ISSUER}/`).setAudience('authenticated')))).toEqual(rejected);
    expect(await status(await custom((jwt) => jwt.setIssuer(ISSUER).setAudience('anon')))).toEqual(rejected);
    expect(await status(await custom((jwt) => jwt.setIssuer(ISSUER).setAudience(['anon', 'service_role'])))).toEqual(rejected);
    expect(await status(await custom((jwt) => jwt.setIssuer(ISSUER)))).toEqual(rejected); // no audience at all
    expect(await status(await custom((jwt) => jwt.setIssuer(ISSUER).setAudience('authenticated').setNotBefore(now + 3600)))).toEqual(rejected);
  });

  it('refuses garbage that is not a token, including very large input, without throwing anything but a 401', async () => {
    for (const junk of ['', ' ', 'x', 'a.b', 'a.b.c', '....', '\u0000', '🔑.🔑.🔑', 'a'.repeat(1_000_000), `${'a'.repeat(2000)}.${'b'.repeat(2000)}.${'c'.repeat(2000)}`]) {
      expect(await status(junk)).toEqual(rejected);
    }
  });
});

describe('claims', () => {
  it('refuses a token with no expiry', async () => {
    expect(await status(await token({ exp: null }))).toEqual(rejected);
  });

  it('refuses a token with no subject, or a subject that is not a uuid', async () => {
    expect(await status(await token({ omit: ['sub'] }))).toEqual(rejected);
    const notUuid = new SignJWT({ session_id: SESSION, email: 'ada@example.com', app_metadata: {} })
      .setProtectedHeader({ alg: 'ES256', kid: 'good-key' })
      .setSubject("1'; drop table users;--")
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('15m')
      .sign(signingKey);
    expect(await status(await notUuid)).toEqual(rejected);
  });

  it('refuses an unknown role, or an org id that is not a uuid, in app_metadata', async () => {
    expect(await status(await token({ payload: { app_metadata: { role: 'superuser', org_id: ORG } } }))).toEqual(rejected);
    expect(await status(await token({ payload: { app_metadata: { role: 'owner', org_id: 'not-a-uuid' } } }))).toEqual(rejected);
    expect(await status(await token({ payload: { app_metadata: { role: ['owner'], org_id: ORG } } }))).toEqual(rejected);
  });

  it('takes role and organization only from app_metadata, never from user_metadata or the top level', async () => {
    const claims = await verify(
      await token({
        payload: {
          role: 'owner',
          org_id: ORG,
          org: ORG,
          user_metadata: { role: 'owner', org_id: ORG },
          app_metadata: {},
        },
      }),
    );
    expect(claims.role).toBeNull();
    expect(claims.org).toBeNull();
  });
});

describe('when the key set cannot be fetched', () => {
  // A paused or unreachable project is not the caller's fault: answering 401 makes every client think
  // its session died and sign the user out, where 503 tells it to try again.
  const unavailable = { code: 'UPSTREAM_UNAVAILABLE', httpStatus: 503 };

  it('answers 503 when the key endpoint cannot be reached', async () => {
    jwksBehavior = () => Promise.reject(new TypeError('fetch failed'));
    expect(await status(await token())).toEqual(unavailable);
  });

  it('answers 503 when the key endpoint answers with a server error or a non-key body', async () => {
    jwksBehavior = () => Promise.resolve(new Response('upstream broke', { status: 502 }));
    expect(await status(await token())).toEqual(unavailable);
    jwksBehavior = () => Promise.resolve(new Response('<html>paused</html>', { status: 200 }));
    expect(await status(await token())).toEqual(unavailable);
    jwksBehavior = () => Promise.resolve(new Response('{"keys":"nope"}', { status: 200 }));
    expect(await status(await token())).toEqual(unavailable);
  });

  it('still refuses (401) a bad token when the key endpoint is healthy but has no matching key', async () => {
    jwksBehavior = () => Promise.resolve(new Response('{"keys":[]}', { status: 200 }));
    expect(await status(await token())).toEqual(rejected);
  });

  it('never lets a token through when the key endpoint is down', async () => {
    jwksBehavior = () => Promise.reject(new TypeError('fetch failed'));
    expect(await status(await token())).not.toBe('accepted');
  });
});
