import { and, desc, eq, ilike, lt, or } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { JobRecommendation, PaginationQuery, RemoteType } from '@atlas/types';
import { decodeCursor, encodeCursor } from '@atlas/utils';
import { toJob } from './jobs.js';

export interface ListScoresResult {
  items: JobRecommendation[];
  nextCursor: string | null;
}

export interface ListScoresFilters {
  location?: string;
  remoteType?: RemoteType;
}

/**
 * Reads scores matching-service has already computed. Correctly returns an
 * empty page until matching-service exists to populate `job_scores` — that's
 * the honest state of the world, not a stub.
 */
export async function listForUser(
  db: Database,
  userId: string,
  filters: ListScoresFilters,
  pagination: PaginationQuery,
): Promise<ListScoresResult> {
  const cursorValue = pagination.cursor ? decodeCursor(pagination.cursor) : null;
  const cursorScore = typeof cursorValue?.score === 'number' ? cursorValue.score : null;
  const cursorId = typeof cursorValue?.id === 'string' ? cursorValue.id : null;

  const conditions = [eq(schema.jobScores.userId, userId)];
  if (filters.remoteType) conditions.push(eq(schema.jobs.remoteType, filters.remoteType));
  if (filters.location) conditions.push(ilike(schema.jobs.location, `%${filters.location}%`));
  if (cursorScore !== null && cursorId) {
    // `score` alone isn't unique — ties at the page boundary need a
    // secondary key or the next page silently drops every other row sharing
    // that exact score, not just the one already returned.
    const tieBreak = or(
      lt(schema.jobScores.score, cursorScore),
      and(eq(schema.jobScores.score, cursorScore), lt(schema.jobScores.jobId, cursorId)),
    );
    if (tieBreak) conditions.push(tieBreak);
  }

  const rows = await db
    .select({ score: schema.jobScores, job: schema.jobs })
    .from(schema.jobScores)
    .innerJoin(schema.jobs, eq(schema.jobScores.jobId, schema.jobs.jobId))
    .where(and(...conditions))
    .orderBy(desc(schema.jobScores.score), desc(schema.jobScores.jobId))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const page = hasMore ? rows.slice(0, pagination.limit) : rows;
  const items: JobRecommendation[] = page.map((row) => ({
    job: toJob(row.job),
    score: row.score.score,
    reasons: row.score.reasons,
  }));
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ score: last.score.score, id: last.score.jobId }) : null,
  };
}

/** Whether `targetUserId` is a member of `organizationId` — used to scope the admin/owner recommendations bypass. */
export async function isOrganizationMember(
  db: Database,
  organizationId: string | null,
  targetUserId: string,
): Promise<boolean> {
  if (!organizationId) return false;
  const [membership] = await db
    .select()
    .from(schema.organizationMembers)
    .where(
      and(
        eq(schema.organizationMembers.organizationId, organizationId),
        eq(schema.organizationMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  return membership !== undefined;
}
