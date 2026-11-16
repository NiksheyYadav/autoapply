import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { vi } from 'vitest';

export const SUPABASE_URL = 'https://test-project.supabase.co';

export interface TestClaims {
  sub: string;
  sid: string;
  org: string | null;
  role: string | null;
  email: string;
}

/**
 * auth-kit fetches the project's JWKS over HTTP. Stubs `fetch` to serve a
 * locally generated key and returns a signer for tokens that verify against it,
 * so tests need no Supabase project. Call `vi.unstubAllGlobals()` when done.
 */
export async function stubJwksAndCreateSigner(): Promise<(claims: TestClaims) => Promise<string>> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );

  return async (claims) =>
    new SignJWT({ session_id: claims.sid, email: claims.email, app_metadata: { org_id: claims.org, role: claims.role } })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(claims.sub)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(privateKey);
}
