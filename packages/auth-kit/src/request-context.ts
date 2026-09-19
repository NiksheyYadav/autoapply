import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedActor } from '@atlas/types';
import { AppError } from '@atlas/utils';
import { buildActor } from './actor.js';
import { verifyAccessToken, type TokenVerifierConfig } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: AuthenticatedActor;
  }
}

function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token) {
    throw new AppError('UNAUTHENTICATED', 'Missing bearer token');
  }
  return token;
}

/**
 * Fastify `preHandler` for any route that requires a signed-in actor. Unlike
 * auth-service's own version, this never touches a database — `permissions`
 * on the resulting actor is always `{}`. Services that need fine-grained
 * permission checks (not just the role already embedded in the token) should
 * look them up themselves rather than relying on this actor's `permissions`.
 */
export function requireAuth(config: TokenVerifierConfig) {
  return async function requireAuthPreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = extractBearerToken(request);
    const claims = await verifyAccessToken(token, config);
    request.actor = buildActor(claims);
  };
}

/** Reads the actor a prior `requireAuth` preHandler attached. Throws if none did. */
export function getActor(request: FastifyRequest): AuthenticatedActor {
  if (!request.actor) {
    throw new AppError('UNAUTHENTICATED', 'Request is missing a resolved actor');
  }
  return request.actor;
}
