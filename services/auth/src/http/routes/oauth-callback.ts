import type { FastifyInstance } from 'fastify';
import { isAppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { writeAuditLog } from '../../repo/audit.js';
import { getPrimaryMembership } from '../../repo/organizations.js';
import { createSession } from '../../repo/sessions.js';
import { findUserByEmail, registerOAuthUser } from '../../repo/users.js';
import { fetchOAuthProfile, isOAuthProvider } from '../../security/oauth.js';
import { verifyOAuthState } from '../../security/oauth-state.js';
import { issueTokenPair } from '../../security/tokens.js';

const STATE_COOKIE = 'atlas_oauth_state';

/**
 * This route is only ever reached by the browser navigating here after a
 * redirect chain through the provider — there's no client-side caller to
 * hand a JSON error to. Every failure path redirects back to the web app's
 * login page with a short, non-sensitive `oauth_error` hint instead.
 */
export function oauthCallbackRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    '/v1/auth/oauth/:provider/callback',
    async (request, reply) => {
      const loginUrl = new URL('/login', deps.env.WEB_APP_URL);
      const failWith = (reason: string) => {
        loginUrl.searchParams.set('oauth_error', reason);
        reply.redirect(loginUrl.toString());
      };

      const stateCookie = request.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: '/v1/auth/oauth' });

      const { provider } = request.params;
      const { code, state, error } = request.query;

      if (!isOAuthProvider(provider)) return failWith('provider');
      if (error) return failWith('denied');
      if (!code || !state || !stateCookie) return failWith('state');

      try {
        const claims = await verifyOAuthState(stateCookie, deps.tokenConfig.secret);
        if (claims.provider !== provider || claims.nonce !== state) {
          return failWith('state');
        }

        const profile = await fetchOAuthProfile(provider, code, deps.env);

        let user = await findUserByEmail(deps.db, profile.email);
        let isNewUser = false;
        if (!user) {
          user = await registerOAuthUser(deps.db, { email: profile.email, fullName: profile.fullName, provider });
          isNewUser = true;
        }

        const membership = isNewUser ? null : await getPrimaryMembership(deps.db, user.userId);

        const session = await createSession(deps.db, {
          userId: user.userId,
          organizationId: membership?.organizationId ?? null,
          userAgent: request.headers['user-agent'],
          ipAddress: request.ip,
          refreshTokenTtlSeconds: deps.env.REFRESH_TOKEN_TTL_SECONDS,
        });

        const tokens = await issueTokenPair(
          {
            sub: user.userId,
            sid: session.sessionId,
            org: membership?.organizationId ?? null,
            role: membership?.role ?? null,
            email: user.email,
          },
          session.refreshToken,
          deps.tokenConfig,
        );

        await writeAuditLog(deps.db, {
          organizationId: membership?.organizationId ?? null,
          actorUserId: user.userId,
          action: isNewUser ? 'auth.oauth_register' : 'auth.oauth_login',
          resourceType: 'session',
          resourceId: session.sessionId,
          traceId: request.id,
          metadata: { provider },
        });

        const callbackUrl = new URL('/oauth/callback', deps.env.WEB_APP_URL);
        callbackUrl.hash = new URLSearchParams({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: String(tokens.expires_in),
          token_type: tokens.token_type,
        }).toString();
        reply.redirect(callbackUrl.toString());
      } catch (cause) {
        request.log.warn({ err: cause, provider }, 'oauth callback failed');
        return failWith(isAppError(cause) ? cause.code.toLowerCase() : 'unknown');
      }
    },
  );
}
