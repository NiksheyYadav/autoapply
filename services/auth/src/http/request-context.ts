import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '@atlas/db';
import type { AuthenticatedActor } from '@atlas/types';
import { AppError } from '@atlas/utils';
import { getMembershipPermissions } from '../repo/organizations.js';
import { buildActor } from '../security/actor.js';
import { verifyAccessToken, type TokenConfig } from '../security/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: AuthenticatedActor;
  }
}

export interface AuthContextDeps {
  db: Database;
  tokenConfig: TokenConfig;
}

function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token) {
    throw new AppError('UNAUTHENTICATED', 'Missing bearer token');
  }
  return token;
}

/** Fastify `preHandler` for any route that requires a signed-in actor. */
export function requireAuth(deps: AuthContextDeps) {
  return async function requireAuthPreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = extractBearerToken(request);
    const claims = await verifyAccessToken(token, deps.tokenConfig);
    const permissions = await getMembershipPermissions(deps.db, claims.sub, claims.org);
    request.actor = buildActor(claims, permissions);
  };
}

/** Reads the actor a prior `requireAuth` preHandler attached. Throws if none did. */
export function getActor(request: FastifyRequest): AuthenticatedActor {
  if (!request.actor) {
    throw new AppError('UNAUTHENTICATED', 'Request is missing a resolved actor');
  }
  return request.actor;
}
