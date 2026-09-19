import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '@atlas/auth-kit';
import { paginationQuerySchema, uuidSchema, type ListContactsResponse } from '@atlas/types';
import type { AppDeps } from '../../app.js';
import { listForCompany, toContact } from '../../repo/contacts.js';

const paramsSchema = z.object({ company_id: uuidSchema });

export function listCompanyContactsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    '/v1/companies/:company_id/contacts',
    { preHandler: requireAuth(deps.tokenVerifier) },
    async (request, reply) => {
      const { company_id } = paramsSchema.parse(request.params);
      const query = paginationQuerySchema.parse(request.query);
      const { items, nextCursor } = await listForCompany(deps.db, company_id, query);
      const response: ListContactsResponse = { items: items.map(toContact), next_cursor: nextCursor };
      reply.status(200).send(response);
    },
  );
}
