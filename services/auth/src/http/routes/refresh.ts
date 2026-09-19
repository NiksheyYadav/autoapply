import type { FastifyInstance } from 'fastify';
import { refreshRequestSchema, type TokenPair } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { getMembership } from '../../repo/organizations.js';
import { writeAuditLog } from '../../repo/audit.js';
import { findSessionByRefreshToken, revokeAllUserSessions, rotateSession } from '../../repo/sessions.js';
import { findUserById } from '../../repo/users.js';
import { issueTokenPair } from '../../security/tokens.js';

export function refreshRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post('/v1/auth/refresh', async (request, reply) => {
    const body = refreshRequestSchema.parse(request.body);
    const session = await findSessionByRefreshToken(deps.db, body.refresh_token);

    if (!session) {
      throw new AppError('SESSION_EXPIRED', 'Refresh token is invalid');
    }

    if (session.revokedAt) {
      // This token was already rotated out (or logged out) — presenting it
      // again means it was stolen. Burn every session the user holds rather
      // than just this one (docs/09 § Abuse prevention).
      await revokeAllUserSessions(deps.db, session.userId);
      await writeAuditLog(deps.db, {
        organizationId: session.organizationId,
        actorUserId: session.userId,
        action: 'auth.session_reuse_detected',
        resourceType: 'session',
        resourceId: session.sessionId,
        traceId: request.id,
      });
      throw new AppError('SESSION_EXPIRED', 'Refresh token is invalid');
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      throw new AppError('SESSION_EXPIRED', 'Refresh token has expired');
    }

    const user = await findUserById(deps.db, session.userId);
    if (!user) {
      throw new AppError('SESSION_EXPIRED', 'Refresh token is invalid');
    }

    const membership = await getMembership(deps.db, user.userId, session.organizationId);
    const next = await rotateSession(deps.db, session, deps.env.REFRESH_TOKEN_TTL_SECONDS);

    const tokens: TokenPair = await issueTokenPair(
      {
        sub: user.userId,
        sid: next.sessionId,
        org: session.organizationId,
        role: membership?.role ?? null,
        email: user.email,
      },
      next.refreshToken,
      deps.tokenConfig,
    );

    await writeAuditLog(deps.db, {
      organizationId: session.organizationId,
      actorUserId: user.userId,
      action: 'auth.refresh',
      resourceType: 'session',
      resourceId: next.sessionId,
      traceId: request.id,
    });

    reply.status(200).send(tokens);
  });
}
