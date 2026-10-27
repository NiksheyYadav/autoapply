import type { FastifyInstance } from 'fastify';
import { getActor, requireAuth, requirePlatformAdmin } from '@atlas/auth-kit';
import {
  upsertJobBoardSourceRequestSchema,
  type JobBoardSource,
  type ListJobBoardSourcesResponse,
} from '@atlas/types';
import { AppError } from '@atlas/utils';
import type { AppDeps } from '../../app.js';
import { normalizeCompanyName } from '../../lib/normalize.js';
import { listAll, listByProvider, toJobBoardSource, upsert } from '../../repo/job-sources.js';

/**
 * Which job boards the scheduled ingestion reads. The catalog these feed is
 * shared by every tenant, so managing the list is a platform-level action:
 * platform administrators only, exactly like `POST /v1/jobs/ingest`.
 */
export function sourcesRoutes(app: FastifyInstance, deps: AppDeps): void {
  const authenticate = requireAuth(deps.tokenVerifier);

  app.get('/v1/jobs/sources', { preHandler: authenticate }, async (request, reply) => {
    requirePlatformAdmin(getActor(request), deps.env.PLATFORM_ADMIN_USER_IDS, 'Only platform administrators can list job sources');

    const rows = await listAll(deps.db);
    const body: ListJobBoardSourcesResponse = { items: rows.map(toJobBoardSource) };
    reply.status(200).send(body);
  });

  app.post('/v1/jobs/sources', { preHandler: authenticate }, async (request, reply) => {
    requirePlatformAdmin(getActor(request), deps.env.PLATFORM_ADMIN_USER_IDS, 'Only platform administrators can manage job sources');

    const input = upsertJobBoardSourceRequestSchema.parse(request.body);

    // Postings are attributed to a company by name, and a board's vanished postings are retired
    // per (provider, company). Two boards of one provider under one name would retire each
    // other's postings, so refuse the pair.
    const wanted = normalizeCompanyName(input.company_name);
    const sameProvider = await listByProvider(deps.db, input.provider);
    const clash = sameProvider.find(
      (other) => other.boardToken !== input.board_token && normalizeCompanyName(other.companyName) === wanted,
    );
    if (clash) {
      throw new AppError(
        'CONFLICT',
        `Another ${input.provider} board (${clash.boardToken}) already uses this company name; give this board a distinct name`,
      );
    }

    const { row, created } = await upsert(deps.db, {
      provider: input.provider,
      boardToken: input.board_token,
      companyName: input.company_name,
      enabled: input.enabled,
    });
    const body: JobBoardSource = toJobBoardSource(row);
    reply.status(created ? 201 : 200).send(body);
  });
}
