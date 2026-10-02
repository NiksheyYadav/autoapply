import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { accessTokenClaimsSchema, type AccessTokenClaims } from '@atlas/types';
import { AppError } from '@atlas/utils';

/**
 * Supabase-issued access tokens are verified against the project's own JWKS
 * — no shared secret to distribute to every service, just the (non-secret)
 * project URL. `custom_access_token_hook` (packages/db/supabase/auth-hooks.sql)
 * stamps org_id/role into app_metadata at issuance time; that's the only
 * non-standard part of the claim shape this needs to unpack.
 */
export interface TokenVerifierConfig {
  jwks: ReturnType<typeof createRemoteJWKSet>;
  issuer: string;
}

export interface TokenVerifierEnvSource {
  SUPABASE_URL: string;
}

export function createTokenVerifierConfig(env: TokenVerifierEnvSource): TokenVerifierConfig {
  const authBase = `${env.SUPABASE_URL}/auth/v1`;
  return {
    jwks: createRemoteJWKSet(new URL(`${authBase}/.well-known/jwks.json`)),
    issuer: authBase,
  };
}

/** Verifies signature, issuer, and expiry, then re-validates the claim shape. */
export async function verifyAccessToken(
  token: string,
  config: TokenVerifierConfig,
): Promise<AccessTokenClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, config.jwks, {
      issuer: config.issuer,
      audience: 'authenticated',
    }));
  } catch (cause) {
    const message =
      cause instanceof joseErrors.JWTExpired ? 'Access token has expired' : 'Access token is invalid';
    throw new AppError('UNAUTHENTICATED', message, { cause });
  }

  const appMetadata = (payload.app_metadata ?? {}) as Record<string, unknown>;
  const parsed = accessTokenClaimsSchema.safeParse({
    sub: payload.sub,
    session_id: payload.session_id,
    org: appMetadata.org_id ?? null,
    role: appMetadata.role ?? null,
    email: payload.email,
  });
  if (!parsed.success) {
    throw new AppError('UNAUTHENTICATED', 'Access token has an invalid shape');
  }
  return parsed.data;
}
