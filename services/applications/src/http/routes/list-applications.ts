import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { listApplicationsQuerySchema, type ListApplicationsResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { listForOrganization, listForUser, toApplication, toApplicationWithJob } from '../../repo/applications.js';

const scopeSchema = z.enum(['mine', 'organization']).default('mine');

export function listApplicationsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/applications', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const query = listApplicationsQuerySchema.parse(request.query);
    const scope = scopeSchema.parse((request.query as { scope?: string }).scope);

    let response: ListApplicationsResponse;
    if (scope === 'organization') {
      // A per-job filter would let staff ask "did anyone apply to job X?", which is
      // exactly the job-level detail staff are not allowed to see.
      if (query.job_id !== undefined) {
        throw new AppError('VALIDATION_ERROR', 'job_id cannot be combined with scope=organization');
      }
      // Org-wide visibility for admin/owner staff (apps/admin), not a
      // per-user default — everyone else keeps seeing only their own.
      if (actor.role !== 'admin' && actor.role !== 'owner') {
        throw new AppError('FORBIDDEN', 'Only org admins/owners can list organization-wide applications');
      }
      if (!actor.organization_id) {
        throw new AppError('VALIDATION_ERROR', 'This account is not attached to an organization');
      }
      // Privacy rule for university/enterprise staff: applications counts and
      // statuses only — never job titles, employer names or apply links. This
      // branch reads and returns plain application rows (`toApplication` has
      // no `job` field), even for staff members' own applications; the job
      // context below is the owner's `mine` view only.
      const result = await listForOrganization(deps.db, actor.organization_id, query);
      response = { items: result.items.map(toApplication), next_cursor: result.nextCursor };
    } else {
      const result = await listForUser(deps.db, actor.user_id, query, { jobId: query.job_id });
      response = {
        items: result.items.map(({ application, job }) => toApplicationWithJob(application, job)),
        next_cursor: result.nextCursor,
      };
    }

    reply.status(200).send(response);
  });
}
