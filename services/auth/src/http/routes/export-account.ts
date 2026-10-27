import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { DEFAULT_EXPORT_LIMITS, fitExportToBudget } from '../../lib/export-budget.js';
import { ACCOUNT_AUDIT_ACTIONS, recordAccountAudit } from '../../repo/audit.js';
import { collectAccountExport } from '../../repo/export.js';

/**
 * GET /v1/auth/me/export: everything Atlas holds about the caller, as one JSON
 * file (`Content-Disposition: attachment`). It is always the caller's own data:
 * the route takes no user id, only the one in the verified token.
 *
 * The body is size-bounded (see lib/export-budget.ts); a cut-short export says
 * so in its own `truncated` list. Each export is recorded in the audit log with
 * the user id only.
 */
export function exportAccountRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/auth/me/export', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    const limits = deps.exportLimits ?? DEFAULT_EXPORT_LIMITS;

    const document = await collectAccountExport(deps.db, actor.user_id, limits);
    if (!document) {
      throw new AppError('USER_NOT_FOUND', 'User no longer exists');
    }
    const body = fitExportToBudget(document, limits.maxBytes);

    await recordAccountAudit(deps.db, {
      action: ACCOUNT_AUDIT_ACTIONS.export,
      userId: actor.user_id,
      actorUserId: actor.user_id,
      traceId: request.id,
      metadata: { truncated_sections: document.truncated.length },
    });
    request.log.info(
      { audit: true, action: ACCOUNT_AUDIT_ACTIONS.export, user_id: actor.user_id, truncated_sections: document.truncated.length },
      'account data exported',
    );

    reply
      .status(200)
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="atlas-data-export-${document.generated_at.slice(0, 10)}.json"`)
      // A personal data file: never to be kept by a shared cache or served again from one.
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(body);
  });
}
