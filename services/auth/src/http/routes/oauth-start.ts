import type { FastifyInstance } from 'fastify';
import { AppError, newToken } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { buildAuthorizeUrl, isOAuthProvider } from '../../security/oauth.js';
import { signOAuthState } from '../../security/oauth-state.js';

const STATE_COOKIE = 'atlas_oauth_state';

export function oauthStartRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { provider: string } }>('/v1/auth/oauth/:provider/start', async (request, reply) => {
    const { provider } = request.params;
    if (!isOAuthProvider(provider)) {
      throw new AppError('OAUTH_PROVIDER_UNAVAILABLE', `Unknown sign-in provider: ${provider}`);
    }

    const nonce = newToken(24);
    const state = await signOAuthState({ provider, nonce }, deps.tokenConfig.secret);
    // Never throws before this point touches the network — buildAuthorizeUrl
    // fails fast with OAUTH_PROVIDER_UNAVAILABLE if this deployment hasn't
    // configured the provider's client id/secret.
    const authorizeUrl = buildAuthorizeUrl(provider, deps.env, nonce);

    reply.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.env.NODE_ENV === 'production',
      path: '/v1/auth/oauth',
      maxAge: 600,
    });
    reply.redirect(authorizeUrl);
  });
}
