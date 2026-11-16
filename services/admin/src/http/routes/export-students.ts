import type { FastifyInstance } from 'fastify';
import { ADMIN_MAX_EXPORT_ROWS, exportStudentsQuerySchema, type RosterStudent } from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { DEFAULT_EXPORT_RATE_PER_MINUTE } from '../../limits.js';
import { rosterToCsv } from '../../lib/export-csv.js';
import { AUDIT_ACTIONS, recordAudit, type AuditToken } from '../../repo/audit.js';
import { listRoster } from '../../repo/roster.js';
import { getOrgScope, orgAdminGuard } from '../guard.js';

const EXPORT_PAGE_SIZE = 1_000;

export function exportStudentsRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    '/v1/admin/organizations/:orgId/export.csv',
    {
      preParsing: orgAdminGuard(deps),
      config: {
        rateLimit: {
          max: deps.limits?.exportRatePerMinute ?? DEFAULT_EXPORT_RATE_PER_MINUTE,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const { organizationId, userId } = getOrgScope(request);
      const { bom, ...filter } = exportStudentsQuerySchema.parse(request.query);
      const maxRows = deps.limits?.exportMaxRows ?? ADMIN_MAX_EXPORT_ROWS;

      // Bounded, not streamed: the export is built in memory up to `maxRows`
      // (ADMIN_MAX_EXPORT_ROWS by default), so the audit entry below records the exact row
      // count and is written *before* any data leaves the service.
      const students: RosterStudent[] = [];
      let cursor: string | undefined;
      do {
        const page = await listRoster(deps.db, organizationId, filter, {
          limit: EXPORT_PAGE_SIZE,
          cursor,
        });
        students.push(...page.items);
        if (students.length > maxRows) {
          throw new AppError(
            'PAYLOAD_TOO_LARGE',
            `An export may contain at most ${maxRows} rows; narrow it with search or filters`,
            { details: { max_rows: maxRows } },
          );
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      // Which filters were applied, never their values: a search term is often an email address.
      const filtersApplied: AuditToken[] = [];
      if (filter.search !== undefined) filtersApplied.push('search');
      if (filter.has_resume !== undefined) filtersApplied.push('has_resume');
      if (filter.application_status !== undefined) filtersApplied.push('application_status');

      await recordAudit(deps.db, {
        organizationId,
        actorUserId: userId,
        action: AUDIT_ACTIONS.studentsExport,
        traceId: request.id,
        metadata: { format: 'csv', row_count: students.length, filters: filtersApplied },
      });

      const csv = rosterToCsv(students, { bom });
      reply
        .status(200)
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="students-${new Date().toISOString().slice(0, 10)}.csv"`,
        )
        .header('x-content-type-options', 'nosniff')
        .send(csv);
    },
  );
}
