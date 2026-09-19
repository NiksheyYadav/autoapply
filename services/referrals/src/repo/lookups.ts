import { desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Company, Job } from '@atlas/types';

/**
 * Read-only cross-service queries against the one shared Postgres instance —
 * same precedent as matching-service and applications-service. Referrals'
 * whole job is connecting a user's applications to contacts at the same
 * company, which unavoidably means reading jobs-service's tables.
 */

export async function findJobById(db: Database, jobId: string): Promise<Job | null> {
  const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.jobId, jobId)).limit(1);
  if (!row) return null;
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

export async function findCompanyById(db: Database, companyId: string): Promise<Company | null> {
  const [row] = await db.select().from(schema.companies).where(eq(schema.companies.companyId, companyId)).limit(1);
  if (!row) return null;
  return {
    company_id: row.companyId,
    name: row.name,
    normalized_name: row.normalizedName,
    industry: row.industry,
    website: row.website,
    domain: row.domain,
    created_at: row.createdAt,
  };
}

export interface UserApplicationCompany {
  applicationId: string;
  jobId: string;
  companyId: string;
}

/** The user's most recent applications, each paired with the job's company. */
export async function listUserApplicationCompanies(
  db: Database,
  userId: string,
  limit: number,
): Promise<UserApplicationCompany[]> {
  const rows = await db
    .select({
      applicationId: schema.applications.applicationId,
      jobId: schema.applications.jobId,
      companyId: schema.jobs.companyId,
    })
    .from(schema.applications)
    .innerJoin(schema.jobs, eq(schema.applications.jobId, schema.jobs.jobId))
    .where(eq(schema.applications.userId, userId))
    .orderBy(desc(schema.applications.createdAt))
    .limit(limit);
  return rows;
}
