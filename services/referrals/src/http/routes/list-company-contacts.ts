import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { paginationQuerySchema, uuidSchema, type ListContactsResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { listForCompany, toContact } from '../../repo/contacts.js';
import { hasUserAppliedToCompany } from '../../repo/lookups.js';

const paramsSchema = z.object({ company_id: uuidSchema });

export function listCompanyContactsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    '/v1/companies/:company_id/contacts',
    { preHandler: requireAuth(deps.tokenVerifier) },
    async (request, reply) => {
      const actor = getActor(request);
      const { company_id } = paramsSchema.parse(request.params);

      // Same bar as findReferralCandidatesForUser: contacts surface only for
      // companies you've actually applied to. Without this, any authenticated
      // user could enumerate any company's contacts by guessing UUIDs — a
      // 404 here (not 403) so a probing request can't distinguish "wrong
      // company" from "not your company."
      const authorized = await hasUserAppliedToCompany(deps.db, actor.user_id, company_id);
      if (!authorized) {
        throw new AppError('NOT_FOUND', 'Company not found');
      }

      const query = paginationQuerySchema.parse(request.query);
      const { items, nextCursor } = await listForCompany(deps.db, company_id, query);
      const response: ListContactsResponse = { items: items.map(toContact), next_cursor: nextCursor };
      reply.status(200).send(response);
    },
  );
}
