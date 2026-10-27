import type { FastifyInstance } from 'fastify';
import { listAdminStudentsQuerySchema, type ListAdminStudentsResponse } from '@atlas/types';
import type { AppDeps } from '../../app.js';
import { listRoster } from '../../repo/roster.js';
import { getOrgScope, orgAdminGuard } from '../guard.js';

export function listStudentsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    '/v1/admin/organizations/:orgId/students',
    { preParsing: orgAdminGuard(deps) },
    async (request, reply) => {
      const { organizationId } = getOrgScope(request);
      const { limit, cursor, ...filter } = listAdminStudentsQuerySchema.parse(request.query);

      const page = await listRoster(deps.db, organizationId, filter, { limit, cursor });

      const response: ListAdminStudentsResponse = {
        items: page.items,
        next_cursor: page.nextCursor,
      };
      reply.status(200).send(response);
    },
  );
}
