import type { FastifyInstance } from 'fastify';
import { adminStudentParamsSchema, type AdminStudentResponse } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { findRosterStudent } from '../../repo/roster.js';
import { getOrgScope, orgAdminGuard } from '../guard.js';

export function getStudentRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    '/v1/admin/organizations/:orgId/students/:studentId',
    { preParsing: orgAdminGuard(deps) },
    async (request, reply) => {
      const { organizationId } = getOrgScope(request);
      const { studentId } = adminStudentParamsSchema.parse(request.params);

      // Scoped by organization in the query itself: a student id from another
      // roster is indistinguishable from one that does not exist.
      const student = await findRosterStudent(deps.db, organizationId, studentId);
      if (!student) {
        throw new AppError('NOT_FOUND', 'Student not found');
      }

      const response: AdminStudentResponse = { student };
      reply.status(200).send(response);
    },
  );
}
