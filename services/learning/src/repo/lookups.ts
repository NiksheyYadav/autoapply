import { desc, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { ModelGroup, ScoredJobRow } from '../lib/metrics.js';

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

/**
 * The same sample and the same split as `listRecentScores` + `listApplicationPairs`
 * fed to `computeLearningMetrics`, as one aggregate query: the database
 * returns one small row per model version instead of two 5000-row lists to
 * fold in memory. This is what the `application.created` handler runs on
 * every application, so its cost must not grow with the sample.
 *
 * "Applied" is an EXISTS against all applications rather than against the
 * latest 5000 of them, so a score is never misclassified as not-applied just
 * because its application fell outside a window.
 */
export async function aggregateModelGroups(db: Database, limit = SAMPLE_LIMIT): Promise<ModelGroup[]> {
  const rows = await db.execute<{
    model_version: string;
    applied_count: number;
    applied_sum: number;
    not_applied_count: number;
    not_applied_sum: number;
  }>(sql`
    WITH recent AS (
      SELECT s.model_version,
             s.score,
             EXISTS (
               SELECT 1 FROM applications a WHERE a.user_id = s.user_id AND a.job_id = s.job_id
             ) AS applied
      FROM (
        SELECT model_version, score, user_id, job_id
        FROM job_scores
        ORDER BY scored_at DESC
        LIMIT ${limit}
      ) s
    )
    SELECT model_version,
           (count(*) FILTER (WHERE applied))::int AS applied_count,
           (coalesce(sum(score) FILTER (WHERE applied), 0))::float8 AS applied_sum,
           (count(*) FILTER (WHERE NOT applied))::int AS not_applied_count,
           (coalesce(sum(score) FILTER (WHERE NOT applied), 0))::float8 AS not_applied_sum
    FROM recent
    GROUP BY model_version
    ORDER BY model_version
  `);
  return rows.map((row) => ({
    modelVersion: row.model_version,
    appliedCount: row.applied_count,
    appliedSum: row.applied_sum,
    notAppliedCount: row.not_applied_count,
    notAppliedSum: row.not_applied_sum,
  }));
}
