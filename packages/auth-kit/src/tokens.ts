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

/**
 * True when verification failed because the key set could not be obtained or read, not because
 * of anything wrong with the token: the endpoint is unreachable, slow, answers with an error, or
 * serves something that is not a key set. A project that is paused or briefly down must read as
 * "try again" (503), not as "this session is invalid" (401), or every client signs its user out.
 * A plain JOSEError (neither a token problem such as a bad signature or an expired claim, nor a
 * more specific key-set error) is what jose raises for a non-200 key-set response.
 */
function isKeySetUnavailable(cause: unknown): boolean {
  if (!(cause instanceof joseErrors.JOSEError)) return true;
  return (
    cause instanceof joseErrors.JWKSTimeout ||
    cause instanceof joseErrors.JWKSInvalid ||
    cause.constructor === joseErrors.JOSEError
  );
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
      // jose treats a missing `exp` as "never expires" unless told otherwise. Supabase always
      // sets both, so a token without them was not issued by it.
      requiredClaims: ['exp', 'sub'],
    }));
  } catch (cause) {
    if (isKeySetUnavailable(cause)) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'Sign-in keys are temporarily unavailable', {
        cause,
      });
    }
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
