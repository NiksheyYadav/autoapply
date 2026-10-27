import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getActor } from '@atlas/auth-kit';
import type { ImportStudentsResponse } from '@atlas/types';
import { AppError, IDEMPOTENCY_HEADER, sha256Hex } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { DEFAULT_IMPORT_RATE_PER_MINUTE } from '../../limits.js';
import {
  csvToRawRows,
  jsonToRawRows,
  planImport,
  validateImportRows,
  type RawImportRow,
} from '../../lib/import-rows.js';
import { AUDIT_ACTIONS, recordAudit } from '../../repo/audit.js';
import { runIdempotent } from '../../repo/idempotency.js';
import { applyRosterImport } from '../../repo/import.js';
import { getOrgScope, orgAdminGuard } from '../guard.js';

/**
 * 5,000 rows of maximum-length fields is a few MB; Vercel rejects request
 * bodies over 4.5 MB anyway, so 4 MiB is the most this route can be asked for.
 */
export const IMPORT_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

const idempotencyKeySchema = z.string().min(8).max(200);

function requireIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED', `${IDEMPOTENCY_HEADER} header is required`);
  }
  return idempotencyKeySchema.parse(raw);
}

/** `preParsing` hook: fail fast on a missing key, before the body is read. */
async function checkIdempotencyKey(request: FastifyRequest): Promise<void> {
  requireIdempotencyKey(request);
}

function mediaType(request: FastifyRequest): string {
  return (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function extractRows(request: FastifyRequest): { source: 'csv' | 'json'; rows: RawImportRow[] } {
  const type = mediaType(request);
  if (type === 'text/csv') {
    if (typeof request.body !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'Request body is empty');
    }
    return { source: 'csv', rows: csvToRawRows(request.body) };
  }
  // Fastify also parses text/plain on its own; only CSV and JSON are meaningful here.
  if (type !== 'application/json' && !type.endsWith('+json')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the roster as text/csv or application/json');
  }
  if (request.body === undefined || request.body === null) {
    throw new AppError('VALIDATION_ERROR', 'Request body is empty');
  }
  return { source: 'json', rows: jsonToRawRows(request.body) };
}

export function importStudentsRoute(app: FastifyInstance, deps: AppDeps): void {
  // Fastify has no CSV parser. The body is kept as a string and parsed (and
  // size-checked) by `csvToRawRows`. Registered on the child plugin's scope, so
  // it applies to this route group only. Multipart upload is intentionally not
  // supported: a browser can send a File straight as the text/csv body.
  app.addContentTypeParser(
    'text/csv',
    { parseAs: 'string', bodyLimit: IMPORT_BODY_LIMIT_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post(
    '/v1/admin/organizations/:orgId/students/import',
    {
      // Auth, membership and the idempotency header are all checked before the
      // (large) body is read.
      preParsing: [orgAdminGuard(deps), checkIdempotencyKey],
      bodyLimit: IMPORT_BODY_LIMIT_BYTES,
      config: {
        rateLimit: {
          max: deps.limits?.importRatePerMinute ?? DEFAULT_IMPORT_RATE_PER_MINUTE,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const { organizationId, userId } = getOrgScope(request);
      const actor = getActor(request);
      const idempotencyKey = requireIdempotencyKey(request);

      // Enforces the row cap (413) and the header / envelope shape (400).
      const { source, rows: rawRows } = extractRows(request);
      const plan = planImport(validateImportRows(rawRows));

      const result = await runIdempotent(
        deps.db,
        {
          // Keys are private to one caller in one organization.
          scope: `admin.students.import:${organizationId}:${userId}`,
          key: idempotencyKey,
          userId: actor.user_id,
          requestHash: sha256Hex(JSON.stringify(rawRows)),
        },
        async (tx) => {
          const applied = await applyRosterImport(tx, organizationId, plan.rows);

          const body: ImportStudentsResponse = {
            total_rows: rawRows.length,
            created: applied.created,
            updated: applied.updated,
            skipped: applied.unchanged + plan.duplicates + applied.noPlatformAccount,
            skipped_breakdown: {
              unchanged: applied.unchanged,
              duplicate_in_file: plan.duplicates,
              no_platform_account: applied.noPlatformAccount,
            },
            errors: plan.errors,
            ignored_fields: plan.ignoredFields,
          };

          // Same transaction as the import: no audit row without the change, no change without one.
          await recordAudit(tx, {
            organizationId,
            actorUserId: actor.user_id,
            action: AUDIT_ACTIONS.studentsImport,
            traceId: request.id,
            metadata: {
              source,
              total_rows: body.total_rows,
              created: body.created,
              updated: body.updated,
              skipped: body.skipped,
              errors: body.errors.length,
            },
          });

          return { status: 200, body };
        },
      );

      if (result.replayed) reply.header('idempotent-replayed', 'true');
      reply.status(result.status).send(result.body);
    },
  );
}
