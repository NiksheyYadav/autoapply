import { sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';

export interface UpsertScoreInput {
  jobId: string;
  userId: string;
  score: number;
  reasons: string[];
  skillGaps: string[];
  modelVersion: string;
}

/**
 * Rows per INSERT. A fan-out is bounded at 500 pairs (see `lookups.ts`), so it
 * is two statements; the cap only keeps a statement from growing if that bound
 * is ever raised (7 bound values per row, far below Postgres' 65535 limit).
 */
const UPSERT_CHUNK = 250;

/** Code-unit order: the same on every runtime, which is all the lock ordering needs. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Idempotent by design: a (job, user) pair scored again replaces its row
 * rather than duplicating it, and an unchanged result writes nothing at all —
 * no new row version, and `scored_at` stays at the time the score last
 * changed. That makes a redelivered event a true no-op here, and lets a retry
 * after a partial failure skip what the failed attempt already wrote.
 *
 * Rows go in one multi-row INSERT per chunk, sorted by (job, user): two
 * handlers racing on overlapping pairs (the same event delivered twice, or a
 * `job.discovered` against a `resume.parsed`) then lock rows in the same order
 * and cannot deadlock. A pair appearing twice keeps its last input.
 */
export async function upsertScores(db: Database, inputs: UpsertScoreInput[]): Promise<void> {
  if (inputs.length === 0) return;

  const byPair = new Map<string, UpsertScoreInput>();
  for (const input of inputs) byPair.set(`${input.jobId}:${input.userId}`, input);
  const ordered = [...byPair.values()].sort(
    (a, b) => compareIds(a.jobId, b.jobId) || compareIds(a.userId, b.userId),
  );

  const table = schema.jobScores;
  const now = new Date().toISOString();
  for (let start = 0; start < ordered.length; start += UPSERT_CHUNK) {
    await db
      .insert(table)
      .values(
        ordered.slice(start, start + UPSERT_CHUNK).map((input) => ({
          jobId: input.jobId,
          userId: input.userId,
          score: input.score,
          reasons: input.reasons,
          skillGaps: input.skillGaps,
          modelVersion: input.modelVersion,
          scoredAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [table.jobId, table.userId],
        set: {
          score: sql`excluded.score`,
          reasons: sql`excluded.reasons`,
          skillGaps: sql`excluded.skill_gaps`,
          modelVersion: sql`excluded.model_version`,
          scoredAt: sql`excluded.scored_at`,
        },
        setWhere: sql`(${table.score}, ${table.reasons}, ${table.skillGaps}, ${table.modelVersion}) is distinct from (excluded.score, excluded.reasons, excluded.skill_gaps, excluded.model_version)`,
      });
  }
}
