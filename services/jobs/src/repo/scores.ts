import { and, desc, eq, lt } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { JobRecommendation, PaginationQuery } from '@atlas/types';
import { decodeCursor, encodeCursor } from '@atlas/utils';
import { toJob } from './jobs.js';

export interface ListScoresResult {
  items: JobRecommendation[];
  nextCursor: string | null;
}

/**
 * Reads scores matching-service has already computed. Correctly returns an
 * empty page until matching-service exists to populate `job_scores` — that's
 * the honest state of the world, not a stub.
 */
export async function listForUser(
  db: Database,
  userId: string,
  pagination: PaginationQuery,
): Promise<ListScoresResult> {
  const cursorValue = pagination.cursor ? decodeCursor(pagination.cursor) : null;
  const cursorScore = typeof cursorValue?.score === 'number' ? cursorValue.score : null;

  const conditions = [eq(schema.jobScores.userId, userId)];
  if (cursorScore !== null) conditions.push(lt(schema.jobScores.score, cursorScore));

  const rows = await db
    .select({ score: schema.jobScores, job: schema.jobs })
    .from(schema.jobScores)
    .innerJoin(schema.jobs, eq(schema.jobScores.jobId, schema.jobs.jobId))
    .where(and(...conditions))
    .orderBy(desc(schema.jobScores.score))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const page = hasMore ? rows.slice(0, pagination.limit) : rows;
  const items: JobRecommendation[] = page.map((row) => ({
    job: toJob(row.job),
    score: row.score.score,
    reasons: row.score.reasons,
  }));
  const lastScore = page[page.length - 1]?.score.score;
  return { items, nextCursor: hasMore && lastScore !== undefined ? encodeCursor({ score: lastScore }) : null };
}
