import type { FastifyInstance } from 'fastify';
import { registerRequestSchema, type AuthSessionResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { writeAuditLog } from '../../repo/audit.js';
import { createSession } from '../../repo/sessions.js';
import { findUserByEmail, registerUser, toPublicUser } from '../../repo/users.js';
import { hashPassword } from '../../security/password.js';
import { issueTokenPair } from '../../security/tokens.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

export function registerRoute(app: FastifyInstance, deps: AppDeps): void {
  app.post(
    '/v1/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = registerRequestSchema.parse(request.body);

      const existing = await findUserByEmail(deps.db, body.email);
      if (existing) {
        throw new AppError('EMAIL_ALREADY_REGISTERED', 'An account with this email already exists');
      }

      const passwordHash = await hashPassword(body.password);

      let user;
      let organization;
      try {
        ({ user, organization } = await registerUser(deps.db, {
          email: body.email,
          fullName: body.full_name,
          passwordHash,
          organizationName: body.organization_name,
        }));
      } catch (cause) {
        // Two concurrent registrations for the same email both pass the check
        // above and race to insert — the DB's unique index is the real guard.
        if ((cause as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new AppError('EMAIL_ALREADY_REGISTERED', 'An account with this email already exists', {
            cause,
          });
        }
        throw cause;
      }

      const session = await createSession(deps.db, {
        userId: user.userId,
        organizationId: organization?.organizationId ?? null,
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
        refreshTokenTtlSeconds: deps.env.REFRESH_TOKEN_TTL_SECONDS,
      });

      const tokens = await issueTokenPair(
        {
          sub: user.userId,
          sid: session.sessionId,
          org: organization?.organizationId ?? null,
          role: organization ? 'owner' : null,
          email: user.email,
        },
        session.refreshToken,
        deps.tokenConfig,
      );

      await writeAuditLog(deps.db, {
        organizationId: organization?.organizationId ?? null,
        actorUserId: user.userId,
        action: 'auth.register',
        resourceType: 'user',
        resourceId: user.userId,
        traceId: request.id,
      });

      const response: AuthSessionResponse = {
        user: toPublicUser(user),
        organization_id: organization?.organizationId ?? null,
        tokens,
      };
      reply.status(201).send(response);
    },
  );
}
