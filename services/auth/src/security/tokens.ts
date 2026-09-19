import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { accessTokenClaimsSchema, type AccessTokenClaims, type TokenPair } from '@atlas/types';
import { AppError } from '@atlas/utils';

export interface TokenConfig {
  secret: Uint8Array;
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
}

export interface TokenEnvSource {
  JWT_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  ACCESS_TOKEN_TTL_SECONDS: number;
}

export function createTokenConfig(env: TokenEnvSource): TokenConfig {
  return {
    secret: new TextEncoder().encode(env.JWT_SECRET),
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

/** Tokens are deliberately small (docs § "not a data channel") — just enough to authorize. */
export async function signAccessToken(claims: AccessTokenClaims, config: TokenConfig): Promise<string> {
  return new SignJWT({ sid: claims.sid, org: claims.org, role: claims.role, email: claims.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + config.accessTokenTtlSeconds)
    .sign(config.secret);
}

/** Verifies signature, issuer, audience, and expiry, then re-validates the claim shape. */
export async function verifyAccessToken(token: string, config: TokenConfig): Promise<AccessTokenClaims> {
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

export async function issueTokenPair(
  claims: AccessTokenClaims,
  refreshToken: string,
  config: TokenConfig,
): Promise<TokenPair> {
  const accessToken = await signAccessToken(claims, config);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: config.accessTokenTtlSeconds,
  };
}
