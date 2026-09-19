import type { FastifyInstance } from 'fastify';
import { loginRequestSchema, type AuthSessionResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { writeAuditLog } from '../../repo/audit.js';
import { getPrimaryMembership } from '../../repo/organizations.js';
import { createSession } from '../../repo/sessions.js';
import { findUserByEmail, recordFailedLogin, recordSuccessfulLogin, toPublicUser } from '../../repo/users.js';
import { verifyPassword } from '../../security/password.js';
import { issueTokenPair } from '../../security/tokens.js';

/** Same message regardless of cause — unknown email, wrong password, or lockout never leaks which. */
function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect');
}

export function loginRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post(
    '/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = loginRequestSchema.parse(request.body);

      const user = await findUserByEmail(deps.db, body.email);
      if (!user || !user.passwordHash) {
        throw invalidCredentials();
      }

      if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
        throw invalidCredentials();
      }

      const passwordValid = await verifyPassword(body.password, user.passwordHash);
      if (!passwordValid) {
        await recordFailedLogin(deps.db, user.userId, user.failedLoginCount);
        await writeAuditLog(deps.db, {
          organizationId: null,
          actorUserId: user.userId,
          action: 'auth.login_failed',
          resourceType: 'user',
          resourceId: user.userId,
          traceId: request.id,
        });
        throw invalidCredentials();
      }

      await recordSuccessfulLogin(deps.db, user.userId);

      const membership = await getPrimaryMembership(deps.db, user.userId);

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
        action: 'auth.login',
        resourceType: 'session',
        resourceId: session.sessionId,
        traceId: request.id,
      });

      const response: AuthSessionResponse = {
        user: toPublicUser(user),
        organization_id: membership?.organizationId ?? null,
        tokens,
      };
      reply.status(200).send(response);
    },
  );
}
