import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { AppError } from '@atlas/utils';
import type { OAuthProvider } from './oauth.js';

/**
 * A distinct audience from access tokens (tokens.ts) so a leaked/reused
 * state JWT can never be mistaken for — or verified as — an access token.
 */
const STATE_AUDIENCE = 'atlas-oauth-state';
const STATE_TTL_SECONDS = 600;

export interface OAuthStateClaims {
  provider: OAuthProvider;
  nonce: string;
}

/**
 * Signs `{provider, nonce}` for the OAuth CSRF cookie. The nonce is echoed
 * back to us by the provider as the `state` query param; the callback route
 * accepts it only if it matches what's in the signed cookie the *browser*
 * carried the whole way — proving the callback belongs to the same browser
 * that started the flow (docs/09 § Abuse prevention pattern, applied to
 * login CSRF rather than session reuse).
 */
export async function signOAuthState(claims: OAuthStateClaims, secret: Uint8Array): Promise<string> {
  return new SignJWT({ provider: claims.provider, nonce: claims.nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(STATE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS)
    .sign(secret);
}

export async function verifyOAuthState(token: string, secret: Uint8Array): Promise<OAuthStateClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, secret, { audience: STATE_AUDIENCE }));
  } catch (cause) {
    const message = cause instanceof joseErrors.JWTExpired ? 'OAuth state has expired' : 'OAuth state is invalid';
    throw new AppError('UNAUTHENTICATED', message, { cause });
  }
  if (typeof payload.provider !== 'string' || typeof payload.nonce !== 'string') {
    throw new AppError('UNAUTHENTICATED', 'OAuth state has an invalid shape');
  }
  return { provider: payload.provider as OAuthProvider, nonce: payload.nonce };
}
