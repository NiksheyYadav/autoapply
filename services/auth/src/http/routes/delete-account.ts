import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth } from '@atlas/auth-kit';
import { deleteAccountRequestSchema, type DeleteAccountResponse } from '@atlas/types';
import type { AppDeps } from '../../app.js';
import { removeStoredFiles } from '../../lib/storage-cleanup.js';
import { ACCOUNT_AUDIT_ACTIONS } from '../../repo/audit.js';
import { deleteAccountData } from '../../repo/delete-account.js';

/**
 * DELETE /v1/auth/me with body `{ "confirm": "DELETE" }`: hard-deletes the
 * caller's data and sign-in account (see repo/delete-account.ts for exactly what
 * that covers and when it refuses with 409).
 *
 * Order matters: authenticate, validate the confirmation, then delete in one
 * transaction, and only after it commits remove the stored resume files. The files
 * come last on purpose: removing them first and then failing the transaction would
 * leave an account whose rows point at files that are gone. A failure removing them
 * is logged (user id, counts, error classes) and reported in the response, but does
 * not undo the deletion.
 *
 * Repeating the request after it succeeded answers 200 again with zero counts
 * rather than an error: the outcome the caller asked for is already true.
 */
export function deleteAccountRoute(app: FastifyInstance, deps: AppDeps): void {
  app.delete('/v1/auth/me', { preHandler: requireAuth(deps.tokenVerifier) }, async (request, reply) => {
    const actor = getActor(request);
    deleteAccountRequestSchema.parse(request.body);

    const outcome = await deleteAccountData(deps.db, actor.user_id, request.id);
    const files = await removeStoredFiles(deps.storage, outcome.storageKeys);

    request.log.info(
      {
        audit: true,
        action: ACCOUNT_AUDIT_ACTIONS.deleted,
        user_id: actor.user_id,
        organizations_deleted: outcome.organizationsDeleted,
        resume_files_total: files.total,
        resume_files_failed: files.failed,
      },
      'account deleted',
    );
    if (files.failed > 0) {
      // Everything needed to finish the job by hand: the files live under resumes/<user_id>/.
      request.log.warn(
        { user_id: actor.user_id, resume_files_failed: files.failed, failure_kinds: files.failureKinds },
        'stored resume files could not be removed after account deletion',
      );
    }

    const response: DeleteAccountResponse = {
      status: 'deleted',
      deleted_at: outcome.deletedAt.toISOString(),
      organizations_deleted: outcome.organizationsDeleted,
      resume_files: { total: files.total, failed: files.failed },
    };
    reply.status(200).header('cache-control', 'no-store').send(response);
  });
}
