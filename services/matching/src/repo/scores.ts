import { schema, type Database } from '@atlas/db';

export interface UpsertScoreInput {
  jobId: string;
  userId: string;
  score: number;
  reasons: string[];
  skillGaps: string[];
  modelVersion: string;
}

/** Idempotent by design: a job re-scored for the same user replaces its row rather than duplicating it. */
export async function upsertScore(db: Database, input: UpsertScoreInput): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(schema.jobScores)
    .values({
      jobId: input.jobId,
      userId: input.userId,
      score: input.score,
      reasons: input.reasons,
      skillGaps: input.skillGaps,
      modelVersion: input.modelVersion,
      scoredAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.jobScores.jobId, schema.jobScores.userId],
      set: {
        score: input.score,
        reasons: input.reasons,
        skillGaps: input.skillGaps,
        modelVersion: input.modelVersion,
        scoredAt: now,
      },
    });
}
