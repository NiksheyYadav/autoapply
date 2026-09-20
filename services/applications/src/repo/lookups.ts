import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';

/**
 * Applications reference a job and a resume owned by jobs-service and
 * profile-service respectively. Read-only cross-service queries against the
 * one shared Postgres instance — the same precedent as matching-service's
 * lookups and jobs-service's `isOrganizationMember` — are used here rather
 * than a synchronous call to either service, since docs/08 reserves
 * synchronous calls for user-triggered reads and this is exactly that.
 */

export interface JobSummary {
  jobId: string;
  isActive: boolean;
}

export async function findActiveJob(db: Database, jobId: string): Promise<JobSummary | null> {
  const [row] = await db
    .select({ jobId: schema.jobs.jobId, isActive: schema.jobs.isActive })
    .from(schema.jobs)
    .where(eq(schema.jobs.jobId, jobId))
    .limit(1);
  return row ?? null;
}

export async function findParsedResumeOwnedBy(
  db: Database,
  resumeId: string,
  userId: string,
): Promise<{ resumeId: string } | null> {
  const [row] = await db
    .select({ resumeId: schema.resumes.resumeId })
    .from(schema.resumes)
    .where(
      and(
        eq(schema.resumes.resumeId, resumeId),
        eq(schema.resumes.userId, userId),
        eq(schema.resumes.status, 'parsed'),
      ),
    )
    .limit(1);
  return row ?? null;
}
