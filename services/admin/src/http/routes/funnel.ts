import type { FastifyInstance } from 'fastify';
import { adminFunnelQuerySchema, type AdminFunnelResponse } from '@atlas/types';
import type { AppDeps } from '../../app.js';
import { computeFunnel } from '../../repo/funnel.js';
import { getOrgScope, orgAdminGuard } from '../guard.js';

export function funnelRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    '/v1/admin/organizations/:orgId/funnel',
    { preParsing: orgAdminGuard(deps) },
    async (request, reply) => {
      const { organizationId } = getOrgScope(request);
      const range = adminFunnelQuerySchema.parse(request.query);

      const counts = await computeFunnel(deps.db, organizationId, range);

      const response: AdminFunnelResponse = {
        organization_id: organizationId,
        range: {
          from: range.from ? new Date(range.from).toISOString() : null,
          to: range.to ? new Date(range.to).toISOString() : null,
        },
        generated_at: new Date().toISOString(),
        ...counts,
      };
      reply.status(200).send(response);
    },
  );
}
