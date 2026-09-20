import { desc } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { ScoredJobRow } from '../lib/metrics.js';

/**
 * Read-only cross-service queries against the one shared Postgres instance —
 * same precedent as matching/applications/referrals/outreach. Measuring
 * whether scores predict applications unavoidably means reading both
 * matching-service's and applications-service's tables.
 */

/** Bounded so one metrics computation stays cheap — same reasoning as
 * matching-service's RESCORE_BATCH_LIMIT. */
const SAMPLE_LIMIT = 5000;

export async function listRecentScores(db: Database, limit = SAMPLE_LIMIT): Promise<ScoredJobRow[]> {
  const rows = await db
    .select({
      modelVersion: schema.jobScores.modelVersion,
      score: schema.jobScores.score,
      userId: schema.jobScores.userId,
      jobId: schema.jobScores.jobId,
    })
    .from(schema.jobScores)
    .orderBy(desc(schema.jobScores.scoredAt))
    .limit(limit);
  return rows;
}

/**
 * `${userId}:${jobId}` pairs with an application — a Set for O(1) lookup
 * while scoring in memory. Ordered by recency, same as `listRecentScores`:
 * an unordered `LIMIT` here would take an arbitrary slice once there are
 * more than SAMPLE_LIMIT applications, so a real application could fall
 * outside the sample and get misclassified as "not applied" even though its
 * score is in the recent-scores sample. Ordering both by recency keeps the
 * two samples aligned to the same window.
 */
export async function listApplicationPairs(db: Database, limit = SAMPLE_LIMIT): Promise<Set<string>> {
  const rows = await db
    .select({ userId: schema.applications.userId, jobId: schema.applications.jobId })
    .from(schema.applications)
    .orderBy(desc(schema.applications.createdAt))
    .limit(limit);
  return new Set(rows.map((row) => `${row.userId}:${row.jobId}`));
}
