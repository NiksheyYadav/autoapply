import { asc, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  ACCOUNT_EXPORT_NOTES,
  ACCOUNT_EXPORT_VERSION,
  type AccountExport,
  type ExportApplication,
  type ExportApplicationEvent,
  type ExportTruncatableSection,
  type ExportTruncation,
} from '@atlas/types';
import { recordTruncation, type ExportLimits } from '../lib/export-budget.js';
import { toIso, toIsoOrNull } from '../lib/timestamps.js';
import { analyticsEventsOf } from './user-references.js';

/** Keeps `cap` rows of a `cap + 1` fetch and notes the cut, so truncation is detected without a count query. */
function capRows<T>(
  rows: T[],
  cap: number,
  section: ExportTruncatableSection,
  truncated: ExportTruncation[],
): T[] {
  if (rows.length <= cap) return rows;
  recordTruncation(truncated, { section, returned: cap, reason: 'row_limit' });
  return rows.slice(0, cap);
}

/**
 * Everything Atlas holds about `userId`, as one document, or null when there is
 * no such user.
 *
 * Every query is keyed on the caller's own id, so another user's rows can only
 * appear through a join, and the joins here reach only the shared job and
 * company listings. Columns that hold credentials or internal pointers are not
 * selected at all (password hash, MFA secret, lockout counters, storage keys,
 * embeddings, connector secret references), rather than selected and stripped,
 * so a future change to a mapper cannot start leaking them.
 *
 * It all runs in one read-only REPEATABLE READ transaction, so the sections
 * describe the same moment.
 */
export async function collectAccountExport(
  db: Database,
  userId: string,
  limits: ExportLimits,
  now: Date = new Date(),
): Promise<AccountExport | null> {
  return db.transaction(
    async (tx) => {
      const [user] = await tx
        .select({
          userId: schema.users.userId,
          profileId: schema.users.profileId,
          email: schema.users.email,
          fullName: schema.users.fullName,
          authProvider: schema.users.authProvider,
          emailVerified: schema.users.emailVerified,
          mfaEnabled: schema.users.mfaEnabled,
          lastLoginAt: schema.users.lastLoginAt,
          createdAt: schema.users.createdAt,
          updatedAt: schema.users.updatedAt,
        })
        .from(schema.users)
        .where(eq(schema.users.userId, userId))
        .limit(1);
      if (!user) return null;

      const truncated: ExportTruncation[] = [];

      const membershipRows = await tx
        .select({
          organizationId: schema.organizations.organizationId,
          name: schema.organizations.name,
          type: schema.organizations.type,
          plan: schema.organizations.plan,
          role: schema.organizationMembers.role,
          permissions: schema.organizationMembers.permissions,
          joinedAt: schema.organizationMembers.createdAt,
        })
        .from(schema.organizationMembers)
        .innerJoin(
          schema.organizations,
          eq(schema.organizations.organizationId, schema.organizationMembers.organizationId),
        )
        .where(eq(schema.organizationMembers.userId, userId))
        .orderBy(asc(schema.organizationMembers.createdAt), asc(schema.organizations.organizationId))
        .limit(limits.rows.organization_memberships + 1);

      const studentRows = await tx
        .select({
          studentId: schema.students.studentId,
          organizationId: schema.students.organizationId,
          department: schema.students.department,
          graduationYear: schema.students.graduationYear,
          currentStatus: schema.students.currentStatus,
          createdAt: schema.students.createdAt,
        })
        .from(schema.students)
        .where(eq(schema.students.userId, userId))
        .orderBy(asc(schema.students.createdAt), asc(schema.students.studentId))
        .limit(limits.rows.student_records + 1);

      const resumeRows = await tx
        .select({
          resumeId: schema.resumes.resumeId,
          originalFilename: schema.resumes.originalFilename,
          contentType: schema.resumes.contentType,
          byteSize: schema.resumes.byteSize,
          status: schema.resumes.status,
          parsedText: schema.resumes.parsedText,
          parsedProfile: schema.resumes.parsedProfile,
          atsScore: schema.resumes.atsScore,
          atsReport: schema.resumes.atsReport,
          failureReason: schema.resumes.failureReason,
          parsedAt: schema.resumes.parsedAt,
          createdAt: schema.resumes.createdAt,
          updatedAt: schema.resumes.updatedAt,
        })
        .from(schema.resumes)
        .where(eq(schema.resumes.userId, userId))
        .orderBy(desc(schema.resumes.createdAt), desc(schema.resumes.resumeId))
        .limit(limits.rows.resumes + 1);

      const applicationRows = await tx
        .select({
          applicationId: schema.applications.applicationId,
          jobId: schema.applications.jobId,
          resumeId: schema.applications.resumeId,
          organizationId: schema.applications.organizationId,
          status: schema.applications.status,
          mode: schema.applications.mode,
          coverLetter: schema.applications.coverLetter,
          submittedAt: schema.applications.submittedAt,
          lastEventAt: schema.applications.lastEventAt,
          failureReason: schema.applications.failureReason,
          createdAt: schema.applications.createdAt,
          jobTitle: schema.jobs.title,
          jobLocation: schema.jobs.location,
          companyName: schema.companies.name,
        })
        .from(schema.applications)
        .leftJoin(schema.jobs, eq(schema.jobs.jobId, schema.applications.jobId))
        .leftJoin(schema.companies, eq(schema.companies.companyId, schema.jobs.companyId))
        .where(eq(schema.applications.userId, userId))
        .orderBy(desc(schema.applications.createdAt), desc(schema.applications.applicationId))
        .limit(limits.rows.applications + 1);

      const applications = capRows(applicationRows, limits.rows.applications, 'applications', truncated);

      const eventRows =
        applications.length === 0
          ? []
          : await tx
              .select({
                eventId: schema.applicationEvents.eventId,
                applicationId: schema.applicationEvents.applicationId,
                fromStatus: schema.applicationEvents.fromStatus,
                toStatus: schema.applicationEvents.toStatus,
                note: schema.applicationEvents.note,
                metadata: schema.applicationEvents.metadata,
                createdAt: schema.applicationEvents.createdAt,
              })
              .from(schema.applicationEvents)
              .where(
                inArray(
                  schema.applicationEvents.applicationId,
                  applications.map((row) => row.applicationId),
                ),
              )
              .orderBy(asc(schema.applicationEvents.createdAt), asc(schema.applicationEvents.eventId))
              .limit(limits.rows.application_events + 1);
      const events = capRows(eventRows, limits.rows.application_events, 'application_events', truncated);

      const eventsByApplication = new Map<string, ExportApplicationEvent[]>();
      for (const row of events) {
        const list = eventsByApplication.get(row.applicationId) ?? [];
        list.push({
          event_id: row.eventId,
          from_status: row.fromStatus,
          to_status: row.toStatus,
          note: row.note,
          metadata: row.metadata,
          created_at: toIso(row.createdAt),
        });
        eventsByApplication.set(row.applicationId, list);
      }

      const messageRows = await tx
        .select({
          messageId: schema.messages.messageId,
          applicationId: schema.messages.applicationId,
          contactId: schema.messages.contactId,
          channel: schema.messages.channel,
          status: schema.messages.status,
          subject: schema.messages.subject,
          body: schema.messages.body,
          scheduledFor: schema.messages.scheduledFor,
          sentAt: schema.messages.sentAt,
          createdAt: schema.messages.createdAt,
        })
        .from(schema.messages)
        .where(eq(schema.messages.userId, userId))
        .orderBy(desc(schema.messages.createdAt), desc(schema.messages.messageId))
        .limit(limits.rows.messages + 1);

      const scoreRows = await tx
        .select({
          jobId: schema.jobScores.jobId,
          score: schema.jobScores.score,
          reasons: schema.jobScores.reasons,
          skillGaps: schema.jobScores.skillGaps,
          modelVersion: schema.jobScores.modelVersion,
          scoredAt: schema.jobScores.scoredAt,
          jobTitle: schema.jobs.title,
          jobLocation: schema.jobs.location,
          companyName: schema.companies.name,
        })
        .from(schema.jobScores)
        .leftJoin(schema.jobs, eq(schema.jobs.jobId, schema.jobScores.jobId))
        .leftJoin(schema.companies, eq(schema.companies.companyId, schema.jobs.companyId))
        .where(eq(schema.jobScores.userId, userId))
        .orderBy(desc(schema.jobScores.score), asc(schema.jobScores.jobId))
        .limit(limits.rows.job_scores + 1);

      const activityRows = await tx
        .select({
          eventId: schema.analyticsEvents.eventId,
          eventType: schema.analyticsEvents.eventType,
          organizationId: schema.analyticsEvents.organizationId,
          payload: schema.analyticsEvents.payload,
          timestamp: schema.analyticsEvents.timestamp,
        })
        .from(schema.analyticsEvents)
        .where(analyticsEventsOf(userId))
        .orderBy(desc(schema.analyticsEvents.timestamp), desc(schema.analyticsEvents.eventId))
        .limit(limits.rows.activity_events + 1);

      const connectorRows = await tx
        .select({
          connectorAccountId: schema.connectorAccounts.connectorAccountId,
          organizationId: schema.connectorAccounts.organizationId,
          provider: schema.connectorAccounts.provider,
          externalAccountId: schema.connectorAccounts.externalAccountId,
          scopes: schema.connectorAccounts.scopes,
          status: schema.connectorAccounts.status,
          consentGrantedAt: schema.connectorAccounts.consentGrantedAt,
          expiresAt: schema.connectorAccounts.expiresAt,
          lastSyncedAt: schema.connectorAccounts.lastSyncedAt,
          createdAt: schema.connectorAccounts.createdAt,
        })
        .from(schema.connectorAccounts)
        .where(eq(schema.connectorAccounts.userId, userId))
        .orderBy(asc(schema.connectorAccounts.createdAt), asc(schema.connectorAccounts.connectorAccountId))
        .limit(limits.rows.connected_accounts + 1);

      const memberships = capRows(membershipRows, limits.rows.organization_memberships, 'organization_memberships', truncated);
      const students = capRows(studentRows, limits.rows.student_records, 'student_records', truncated);
      const resumes = capRows(resumeRows, limits.rows.resumes, 'resumes', truncated);
      const messages = capRows(messageRows, limits.rows.messages, 'messages', truncated);
      const scores = capRows(scoreRows, limits.rows.job_scores, 'job_scores', truncated);
      const activity = capRows(activityRows, limits.rows.activity_events, 'activity_events', truncated);
      const connectors = capRows(connectorRows, limits.rows.connected_accounts, 'connected_accounts', truncated);

      return {
        export_version: ACCOUNT_EXPORT_VERSION,
        generated_at: now.toISOString(),
        user: {
          user_id: user.userId,
          email: user.email,
          full_name: user.fullName,
          auth_provider: user.authProvider,
          email_verified: user.emailVerified,
          mfa_enabled: user.mfaEnabled,
          primary_resume_id: user.profileId,
          last_login_at: toIsoOrNull(user.lastLoginAt),
          created_at: toIso(user.createdAt),
          updated_at: toIso(user.updatedAt),
        },
        organization_memberships: memberships.map((row) => ({
          organization: {
            organization_id: row.organizationId,
            name: row.name,
            type: row.type,
            plan: row.plan,
          },
          role: row.role,
          permissions: row.permissions,
          joined_at: toIso(row.joinedAt),
        })),
        student_records: students.map((row) => ({
          student_id: row.studentId,
          organization_id: row.organizationId,
          department: row.department,
          graduation_year: row.graduationYear,
          current_status: row.currentStatus,
          created_at: toIso(row.createdAt),
        })),
        resumes: resumes.map((row) => ({
          resume_id: row.resumeId,
          original_filename: row.originalFilename,
          content_type: row.contentType,
          byte_size: row.byteSize,
          status: row.status,
          parsed_text: row.parsedText,
          parsed_profile: row.parsedProfile,
          ats_score: row.atsScore,
          ats_report: row.atsReport,
          failure_reason: row.failureReason,
          parsed_at: toIsoOrNull(row.parsedAt),
          created_at: toIso(row.createdAt),
          updated_at: toIso(row.updatedAt),
        })),
        applications: applications.map(
          (row): ExportApplication => ({
            application_id: row.applicationId,
            job: {
              job_id: row.jobId,
              title: row.jobTitle,
              company_name: row.companyName,
              location: row.jobLocation,
            },
            resume_id: row.resumeId,
            organization_id: row.organizationId,
            status: row.status,
            mode: row.mode,
            cover_letter: row.coverLetter,
            submitted_at: toIsoOrNull(row.submittedAt),
            last_event_at: toIso(row.lastEventAt),
            failure_reason: row.failureReason,
            created_at: toIso(row.createdAt),
            events: eventsByApplication.get(row.applicationId) ?? [],
          }),
        ),
        messages: messages.map((row) => ({
          message_id: row.messageId,
          application_id: row.applicationId,
          contact_id: row.contactId,
          channel: row.channel,
          status: row.status,
          subject: row.subject,
          body: row.body,
          scheduled_for: toIsoOrNull(row.scheduledFor),
          sent_at: toIsoOrNull(row.sentAt),
          created_at: toIso(row.createdAt),
        })),
        job_scores: scores.map((row) => ({
          job: {
            job_id: row.jobId,
            title: row.jobTitle,
            company_name: row.companyName,
            location: row.jobLocation,
          },
          score: row.score,
          reasons: row.reasons,
          skill_gaps: row.skillGaps,
          model_version: row.modelVersion,
          scored_at: toIso(row.scoredAt),
        })),
        activity_events: activity.map((row) => ({
          event_id: row.eventId,
          event_type: row.eventType,
          organization_id: row.organizationId,
          payload: row.payload,
          occurred_at: toIso(row.timestamp),
        })),
        connected_accounts: connectors.map((row) => ({
          connector_account_id: row.connectorAccountId,
          organization_id: row.organizationId,
          provider: row.provider,
          external_account_id: row.externalAccountId,
          scopes: row.scopes,
          status: row.status,
          consent_granted_at: toIsoOrNull(row.consentGrantedAt),
          expires_at: toIsoOrNull(row.expiresAt),
          last_synced_at: toIsoOrNull(row.lastSyncedAt),
          created_at: toIso(row.createdAt),
        })),
        truncated,
        notes: [...ACCOUNT_EXPORT_NOTES],
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
