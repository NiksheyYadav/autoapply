import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { ApplicationJobSummary, EmploymentType, RemoteType } from '@atlas/types';
import { toSafeApplyUrl } from '../lib/apply-url.js';

/**
 * Applications reference a job and a resume owned by jobs-service and
 * profile-service respectively. Read-only cross-service queries against the
 * one shared Postgres instance — the same precedent as matching-service's
 * lookups and jobs-service's `isOrganizationMember` — are used here rather
 * than a synchronous call to either service, since docs/08 reserves
 * synchronous calls for user-triggered reads and this is exactly that.
 */

/**
 * The columns that make up an {@link ApplicationJobSummary}: jobs joined to
 * their company. Exactly these and nothing else — `jobs` also holds the
 * description (up to 200k chars) and an embedding, which an application list
 * must never drag along. Shared by the single-job lookup and the application
 * list/get joins so the summary has one definition.
 */
export const jobSummaryColumns = {
  jobId: schema.jobs.jobId,
  title: schema.jobs.title,
  companyId: schema.jobs.companyId,
  companyName: schema.companies.name,
  location: schema.jobs.location,
  remoteType: schema.jobs.remoteType,
  employmentType: schema.jobs.employmentType,
  applyUrl: schema.jobs.applyUrl,
  isActive: schema.jobs.isActive,
};

/**
 * {@link jobSummaryColumns} as a LEFT JOIN returns them: every field is null
 * when the job row, or its company row, is missing.
 */
export interface JobSummaryRow {
  jobId: string | null;
  title: string | null;
  companyId: string | null;
  companyName: string | null;
  location: string | null;
  remoteType: RemoteType | null;
  employmentType: EmploymentType | null;
  applyUrl: string | null;
  isActive: boolean | null;
}

/**
 * Null-safe: a job summary needs both the job and its company, so a missing
 * row on either side of the join yields null rather than a half-empty object.
 */
export function toJobSummary(row: JobSummaryRow): ApplicationJobSummary | null {
  if (
    row.jobId === null ||
    row.title === null ||
    row.companyId === null ||
    row.companyName === null ||
    row.remoteType === null ||
    row.employmentType === null ||
    row.isActive === null
  ) {
    return null;
  }
  return {
    job_id: row.jobId,
    title: row.title,
    company_id: row.companyId,
    company_name: row.companyName,
    location: row.location,
    remote_type: row.remoteType,
    employment_type: row.employmentType,
    apply_url: toSafeApplyUrl(row.applyUrl),
    is_active: row.isActive,
  };
}

/** One job with its company, or null when either row is missing. Includes inactive jobs — callers decide. */
export async function findJobSummary(db: Database, jobId: string): Promise<ApplicationJobSummary | null> {
  const [row] = await db
    .select(jobSummaryColumns)
    .from(schema.jobs)
    .innerJoin(schema.companies, eq(schema.companies.companyId, schema.jobs.companyId))
    .where(eq(schema.jobs.jobId, jobId))
    .limit(1);
  return row ? toJobSummary(row) : null;
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
