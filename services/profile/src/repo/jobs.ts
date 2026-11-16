import { eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { OptimizationTarget } from '@atlas/ai';

/**
 * Resume optimization compares a resume against a job posting, so
 * profile-service reads the jobs table directly through the one shared
 * Postgres instance every service already connects to — the same read-only
 * cross-service lookup applications-service and matching-service already use
 * (services/applications/src/repo/lookups.ts). It never writes to `jobs`.
 *
 * Deliberately not filtered on `is_active`: tailoring a resume to a posting
 * that has since expired is still valid advice.
 */
export async function findOptimizationTarget(db: Database, jobId: string): Promise<OptimizationTarget | null> {
  const [row] = await db
    .select({ title: schema.jobs.title, description: schema.jobs.description, skills: schema.jobs.skills })
    .from(schema.jobs)
    .where(eq(schema.jobs.jobId, jobId))
    .limit(1);
  return row ?? null;
}
