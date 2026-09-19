import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Job, ParsedProfile } from '@atlas/types';

/**
 * Matching-service's whole job is joining data owned by profile-service and
 * jobs-service, so it reads their tables directly through the one shared
 * Postgres instance every service already connects to — the same read-only
 * cross-service query already established for org-scoped authorization in
 * jobs-service's `isOrganizationMember` (services/jobs/src/repo/scores.ts).
 * It never writes to either table.
 */

/** How `toJob` in services/jobs/src/repo/jobs.ts maps a row — duplicated here
 * rather than imported, since services never import from other services. */
function toJob(row: typeof schema.jobs.$inferSelect): Job {
  return {
    job_id: row.jobId,
    company_id: row.companyId,
    title: row.title,
    description: row.description,
    salary_min: row.salaryMin,
    salary_max: row.salaryMax,
    salary_currency: row.salaryCurrency,
    location: row.location,
    remote_type: row.remoteType,
    employment_type: row.employmentType,
    source: row.source,
    external_id: row.externalId,
    apply_url: row.applyUrl,
    job_hash: row.jobHash,
    skills: row.skills.slice(0, 200),
    posted_at: row.postedAt,
    expires_at: row.expiresAt,
    is_active: row.isActive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function findJobById(db: Database, jobId: string): Promise<Job | null> {
  const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.jobId, jobId)).limit(1);
  return row ? toJob(row) : null;
}

/**
 * Most recently posted active jobs, bounded to keep one `job.discovered` (or
 * `resume.parsed`) event's fan-out work finite. A production system would
 * page through the full active set via its own queue instead of one bounded
 * pass — deferred until there's enough job volume to need it.
 */
const RESCORE_BATCH_LIMIT = 500;

export async function listActiveJobs(db: Database, limit = RESCORE_BATCH_LIMIT): Promise<Job[]> {
  const rows = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.isActive, true))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(limit);
  return rows.map(toJob);
}

export async function findLatestParsedProfile(
  db: Database,
  userId: string,
): Promise<ParsedProfile | null> {
  const [row] = await db
    .select({ parsedProfile: schema.resumes.parsedProfile })
    .from(schema.resumes)
    .where(and(eq(schema.resumes.userId, userId), eq(schema.resumes.status, 'parsed')))
    .orderBy(desc(schema.resumes.parsedAt))
    .limit(1);
  return row?.parsedProfile ?? null;
}

/** Users with at least one successfully parsed resume, most recent first. */
export async function listCandidateUserIds(db: Database, limit = RESCORE_BATCH_LIMIT): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.resumes.userId })
    .from(schema.resumes)
    .where(eq(schema.resumes.status, 'parsed'))
    .orderBy(desc(schema.resumes.parsedAt))
    .limit(limit);
  // A user with multiple parsed resumes appears once per resume; de-dupe.
  return [...new Set(rows.map((row) => row.userId))];
}
