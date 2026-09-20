import { AppError } from '@atlas/utils';
import type { AuthServiceEnv } from '../env.js';

export const OAUTH_PROVIDERS = ['google', 'microsoft'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export interface OAuthProfile {
  email: string;
  fullName: string;
}

interface ProviderEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
}

function endpointsFor(provider: OAuthProvider, env: AuthServiceEnv): ProviderEndpoints {
  if (provider === 'google') {
    return {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
      scope: 'openid email profile',
    };
  }
  return {
    authorizeUrl: `https://login.microsoftonline.com/${env.MICROSOFT_TENANT}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${env.MICROSOFT_TENANT}/oauth2/v2.0/token`,
    userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile',
  };
}

/** Throws OAUTH_PROVIDER_UNAVAILABLE when this deployment has no secret configured for it. */
function credentialsFor(provider: OAuthProvider, env: AuthServiceEnv): { clientId: string; clientSecret: string } {
  const { clientId, clientSecret } =
    provider === 'google'
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET };
  if (!clientId || !clientSecret) {
    throw new AppError('OAUTH_PROVIDER_UNAVAILABLE', `Sign-in with ${provider} is not configured on this deployment`);
  }
  return { clientId, clientSecret };
}

export function redirectUriFor(provider: OAuthProvider, env: AuthServiceEnv): string {
  return `${env.OAUTH_REDIRECT_BASE_URL}/v1/auth/oauth/${provider}/callback`;
}

/** The URL to send the browser to for the provider's consent screen. Throws if unconfigured. */
export function buildAuthorizeUrl(provider: OAuthProvider, env: AuthServiceEnv, state: string): string {
  const { clientId } = credentialsFor(provider, env);
  const { authorizeUrl, scope } = endpointsFor(provider, env);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUriFor(provider, env),
    response_type: 'code',
    scope,
    state,
  });
  return `${authorizeUrl}?${params.toString()}`;
}

interface OAuthTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface OAuthUserinfoResponse {
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
}

/** Exchanges an authorization code for the signed-in user's email + display name. */
export async function fetchOAuthProfile(
  provider: OAuthProvider,
  code: string,
  env: AuthServiceEnv,
): Promise<OAuthProfile> {
  const { clientId, clientSecret } = credentialsFor(provider, env);
  const { tokenUrl, userinfoUrl } = endpointsFor(provider, env);

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUriFor(provider, env),
      grant_type: 'authorization_code',
    }),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as OAuthTokenResponse;
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw new AppError('UPSTREAM_UNAVAILABLE', `${provider} rejected the authorization code`, {
      details: tokenBody.error_description ?? tokenBody.error,
    });
  }

  const profileRes = await fetch(userinfoUrl, {
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
  });
  if (!profileRes.ok) {
    throw new AppError('UPSTREAM_UNAVAILABLE', `Could not read profile from ${provider}`);
  }
  const profile = (await profileRes.json()) as OAuthUserinfoResponse;
  if (!profile.email) {
    throw new AppError('UPSTREAM_UNAVAILABLE', `${provider} did not return an email address`);
  }

  const joinedName = [profile.given_name, profile.family_name].filter(Boolean).join(' ');
  const fullName = profile.name ?? (joinedName || profile.email);

  return { email: profile.email, fullName };
}
