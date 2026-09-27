import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const ISSUER = 'https://test-project.supabase.co/auth/v1';

const claims = {
  sub: '11111111-1111-4111-8111-111111111111',
  session_id: '22222222-2222-4222-8222-222222222222',
  org: null as string | null,
  role: null as string | null,
  email: 'ada@example.com',
};

let publicJwk: JWK;
let sign: (overrides?: { aud?: string; issuer?: string; ttlSeconds?: number; appMetadata?: Record<string, unknown> }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';

  sign = async (overrides = {}) => {
    const appMetadata = overrides.appMetadata ?? (claims.org !== null || claims.role !== null
      ? { org_id: claims.org, role: claims.role }
      : {});
    return new SignJWT({ session_id: claims.session_id, email: claims.email, app_metadata: appMetadata })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(claims.sub)
      .setIssuer(overrides.issuer ?? ISSUER)
      .setAudience(overrides.aud ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (overrides.ttlSeconds ?? 900))
      .sign(privateKey);
  };
});

// createRemoteJWKSet fetches over HTTP — stub global fetch to serve our
// locally generated test key instead of hitting a real Supabase project.
vi.stubGlobal('fetch', async () =>
  new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
);

const { createTokenVerifierConfig, verifyAccessToken } = await import('../src/tokens.js');
const config = createTokenVerifierConfig({ SUPABASE_URL: 'https://test-project.supabase.co' });

describe('verifyAccessToken', () => {
  it('accepts a token signed by the project JWKS, extracting org/role from app_metadata', async () => {
    const token = await sign({ appMetadata: { org_id: '33333333-3333-4333-8333-333333333333', role: 'admin' } });
    await expect(verifyAccessToken(token, config)).resolves.toEqual({
      ...claims,
      org: '33333333-3333-4333-8333-333333333333',
      role: 'admin',
    });
  });

  it('defaults org/role to null when app_metadata has neither', async () => {
    const token = await sign();
    await expect(verifyAccessToken(token, config)).resolves.toEqual(claims);
  });

  it('rejects a token issued for a different audience', async () => {
    const token = await sign({ aud: 'someone-else' });
    await expect(verifyAccessToken(token, config)).rejects.toThrow();
  });

  it('rejects a token issued by a different project', async () => {
    const token = await sign({ issuer: 'https://another-project.supabase.co/auth/v1' });
    await expect(verifyAccessToken(token, config)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await sign({ ttlSeconds: -10 });
    await expect(verifyAccessToken(token, config)).rejects.toThrow();
  });

  it('rejects a malformed bearer string', async () => {
    await expect(verifyAccessToken('not-a-jwt', config)).rejects.toThrow();
  });
});
