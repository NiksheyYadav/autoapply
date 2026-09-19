import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';

/**
 * Read-only cross-service queries against the one shared Postgres instance —
 * same precedent as matching-service, applications-service, and
 * referrals-service. Drafting a message unavoidably needs the application,
 * job, company, contact, and resume it's about.
 */

export interface ApplicationSummary {
  applicationId: string;
  userId: string;
  jobId: string;
  resumeId: string | null;
}

export async function findApplicationOwnedBy(
  db: Database,
  applicationId: string,
  userId: string,
): Promise<ApplicationSummary | null> {
  const [row] = await db
    .select({
      applicationId: schema.applications.applicationId,
      userId: schema.applications.userId,
      jobId: schema.applications.jobId,
      resumeId: schema.applications.resumeId,
    })
    .from(schema.applications)
    .where(and(eq(schema.applications.applicationId, applicationId), eq(schema.applications.userId, userId)))
    .limit(1);
  return row ?? null;
}

export interface JobSummary {
  title: string;
  companyId: string;
  skills: string[];
}

export async function findJobById(db: Database, jobId: string): Promise<JobSummary | null> {
  const [row] = await db
    .select({ title: schema.jobs.title, companyId: schema.jobs.companyId, skills: schema.jobs.skills })
    .from(schema.jobs)
    .where(eq(schema.jobs.jobId, jobId))
    .limit(1);
  return row ?? null;
}

export async function findCompanyName(db: Database, companyId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: schema.companies.name })
    .from(schema.companies)
    .where(eq(schema.companies.companyId, companyId))
    .limit(1);
  return row?.name ?? null;
}

export interface ContactSummary {
  fullName: string | null;
  title: string | null;
}

export async function findContactById(db: Database, contactId: string): Promise<ContactSummary | null> {
  const [row] = await db
    .select({ fullName: schema.contacts.fullName, title: schema.contacts.title })
    .from(schema.contacts)
    .where(eq(schema.contacts.contactId, contactId))
    .limit(1);
  return row ?? null;
}

export interface CandidateSummary {
  fullName: string | null;
  topSkills: string[];
}

export async function findCandidateSummary(db: Database, userId: string): Promise<CandidateSummary | null> {
  const [row] = await db
    .select({ parsedProfile: schema.resumes.parsedProfile })
    .from(schema.resumes)
    .where(and(eq(schema.resumes.userId, userId), eq(schema.resumes.status, 'parsed')))
    .orderBy(desc(schema.resumes.parsedAt))
    .limit(1);
  if (!row?.parsedProfile) return null;
  return {
    fullName: row.parsedProfile.full_name,
    topSkills: row.parsedProfile.skills.slice(0, 3).map((skill) => skill.name),
  };
}
