import { errors as joseErrors, jwtVerify } from 'jose';
import { accessTokenClaimsSchema, type AccessTokenClaims } from '@atlas/types';
import { AppError } from '@atlas/utils';

/**
 * The verify-only half of auth-service's token config. Any service that
 * trusts the same JWT_SECRET/issuer/audience can check a caller's identity
 * without a network call back to auth-service or its own DB.
 */
export interface TokenVerifierConfig {
  secret: Uint8Array;
  issuer: string;
  audience: string;
}

export interface TokenVerifierEnvSource {
  JWT_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
}

export function createTokenVerifierConfig(env: TokenVerifierEnvSource): TokenVerifierConfig {
  return {
    secret: new TextEncoder().encode(env.JWT_SECRET),
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  };
}

/** Verifies signature, issuer, audience, and expiry, then re-validates the claim shape. */
export async function verifyAccessToken(
  token: string,
  config: TokenVerifierConfig,
): Promise<AccessTokenClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, config.secret, {
      issuer: config.issuer,
      audience: config.audience,
    }));
  } catch (cause) {
    const message =
      cause instanceof joseErrors.JWTExpired ? 'Access token has expired' : 'Access token is invalid';
    throw new AppError('UNAUTHENTICATED', message, { cause });
  }

  const parsed = accessTokenClaimsSchema.safeParse({
    sub: payload.sub,
    sid: payload.sid,
    org: payload.org ?? null,
    role: payload.role ?? null,
    email: payload.email,
  });
  if (!parsed.success) {
    throw new AppError('UNAUTHENTICATED', 'Access token has an invalid shape');
  }
  return parsed.data;
}
