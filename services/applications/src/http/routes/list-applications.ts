import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { listApplicationsQuerySchema, type ListApplicationsResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { listForOrganization, listForUser, toApplication } from '../../repo/applications.js';

const scopeSchema = z.enum(['mine', 'organization']).default('mine');

export function listApplicationsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/applications', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const query = listApplicationsQuerySchema.parse(request.query);
    const scope = scopeSchema.parse((request.query as { scope?: string }).scope);

    let result;
    if (scope === 'organization') {
      // Org-wide visibility for admin/owner staff (apps/admin), not a
      // per-user default — everyone else keeps seeing only their own.
      if (actor.role !== 'admin' && actor.role !== 'owner') {
        throw new AppError('FORBIDDEN', 'Only org admins/owners can list organization-wide applications');
      }
      if (!actor.organization_id) {
        throw new AppError('VALIDATION_ERROR', 'This account is not attached to an organization');
      }
      result = await listForOrganization(deps.db, actor.organization_id, query);
    } else {
      result = await listForUser(deps.db, actor.user_id, query);
    }

    const response: ListApplicationsResponse = { items: result.items.map(toApplication), next_cursor: result.nextCursor };
    reply.status(200).send(response);
  });
}
