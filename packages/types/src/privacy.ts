import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import {
  applicationModeSchema,
  applicationStatusSchema,
  authProviderSchema,
  memberRoleSchema,
  messageChannelSchema,
  messageStatusSchema,
  organizationPlanSchema,
  organizationTypeSchema,
  resumeStatusSchema,
} from './enums.js';
import { permissionsSchema } from './identity.js';
import { parsedProfileSchema } from './profile.js';

/**
 * Contracts for the account-privacy endpoints served by auth-service
 * (docs/09 § Data export and deletion):
 *
 *   GET    /v1/auth/me/export   everything Atlas holds about the caller, as one JSON download
 *   DELETE /v1/auth/me          hard-delete the caller's data and sign-in account
 *
 * Both act only on the authenticated caller; neither takes a user id.
 */

// --- export -------------------------------------------------------------------

/** Bump when a field is removed or changes meaning (adding a field does not need it). */
export const ACCOUNT_EXPORT_VERSION = 1 as const;

/**
 * What is deliberately NOT in the export, so the file says so itself instead of
 * leaving a reader to wonder. Kept next to the schema so the list and the
 * behaviour are reviewed together.
 */
export const ACCOUNT_EXPORT_NOTES = [
  'Password hashes, multi-factor secrets, access tokens and connector credentials are never exported.',
  'Original uploaded resume files and machine-generated embedding vectors are not included; resume text and the parsed profile are.',
  'Data about other people is not included. Outreach messages reference contacts by id only.',
  'Referral suggestions are computed from your applications when you view them and are not stored. Outreach you created is under messages; referral events are under activity_events.',
  'Internal operational records (request de-duplication keys, event queue entries, audit entries) are not included.',
  'Sign-in records held by Supabase Auth (identities, sessions) are managed by that service and are not part of this file.',
] as const;

/** The list sections that can be cut short to keep the download small. */
export const EXPORT_TRUNCATABLE_SECTIONS = [
  'organization_memberships',
  'student_records',
  'resumes',
  'applications',
  'application_events',
  'messages',
  'job_scores',
  'activity_events',
  'connected_accounts',
] as const;

export const exportTruncatableSectionSchema = z.enum(EXPORT_TRUNCATABLE_SECTIONS);
export type ExportTruncatableSection = z.infer<typeof exportTruncatableSectionSchema>;

/** Why a section holds fewer rows than exist. `truncated` is empty when the export is complete. */
export const exportTruncationSchema = z.object({
  section: exportTruncatableSectionSchema,
  /** How many rows the file contains for this section. */
  returned: z.number().int().min(0),
  reason: z.enum(['row_limit', 'size_limit']),
});

export type ExportTruncation = z.infer<typeof exportTruncationSchema>;

/** The account row, minus every credential-bearing column. */
export const exportUserSchema = z.object({
  user_id: uuidSchema,
  email: z.string(),
  full_name: z.string(),
  auth_provider: authProviderSchema,
  email_verified: z.boolean(),
  mfa_enabled: z.boolean(),
  /** The resume currently treated as the canonical profile. */
  primary_resume_id: uuidSchema.nullable(),
  last_login_at: isoTimestampSchema.nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});

export type ExportUser = z.infer<typeof exportUserSchema>;

export const exportMembershipSchema = z.object({
  organization: z.object({
    organization_id: uuidSchema,
    name: z.string(),
    type: organizationTypeSchema,
    plan: organizationPlanSchema,
  }),
  role: memberRoleSchema,
  permissions: permissionsSchema,
  joined_at: isoTimestampSchema,
});

export type ExportMembership = z.infer<typeof exportMembershipSchema>;

export const exportStudentRecordSchema = z.object({
  student_id: uuidSchema,
  organization_id: uuidSchema,
  department: z.string().nullable(),
  graduation_year: z.number().int().nullable(),
  current_status: z.string(),
  created_at: isoTimestampSchema,
});

export type ExportStudentRecord = z.infer<typeof exportStudentRecordSchema>;

export const exportResumeSchema = z.object({
  resume_id: uuidSchema,
  original_filename: z.string(),
  content_type: z.string(),
  byte_size: z.number().int().min(0),
  status: resumeStatusSchema,
  parsed_text: z.string().nullable(),
  parsed_profile: parsedProfileSchema.nullable(),
  ats_score: z.number().nullable(),
  ats_report: z.record(z.string(), z.unknown()).nullable(),
  failure_reason: z.string().nullable(),
  parsed_at: isoTimestampSchema.nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});

export type ExportResume = z.infer<typeof exportResumeSchema>;

export const exportApplicationEventSchema = z.object({
  event_id: uuidSchema,
  from_status: applicationStatusSchema.nullable(),
  to_status: applicationStatusSchema,
  note: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: isoTimestampSchema,
});

export type ExportApplicationEvent = z.infer<typeof exportApplicationEventSchema>;

/** The shared job listing an application or score points at, for context only. */
export const exportJobContextSchema = z.object({
  job_id: uuidSchema,
  title: z.string().nullable(),
  company_name: z.string().nullable(),
  location: z.string().nullable(),
});

export type ExportJobContext = z.infer<typeof exportJobContextSchema>;

export const exportApplicationSchema = z.object({
  application_id: uuidSchema,
  job: exportJobContextSchema,
  resume_id: uuidSchema.nullable(),
  organization_id: uuidSchema.nullable(),
  status: applicationStatusSchema,
  mode: applicationModeSchema,
  cover_letter: z.string().nullable(),
  submitted_at: isoTimestampSchema.nullable(),
  last_event_at: isoTimestampSchema,
  failure_reason: z.string().nullable(),
  created_at: isoTimestampSchema,
  events: z.array(exportApplicationEventSchema),
});

export type ExportApplication = z.infer<typeof exportApplicationSchema>;

export const exportMessageSchema = z.object({
  message_id: uuidSchema,
  application_id: uuidSchema.nullable(),
  /** Id only: the contact's own details belong to the contact, not to this export. */
  contact_id: uuidSchema.nullable(),
  channel: messageChannelSchema,
  status: messageStatusSchema,
  subject: z.string().nullable(),
  body: z.string(),
  scheduled_for: isoTimestampSchema.nullable(),
  sent_at: isoTimestampSchema.nullable(),
  created_at: isoTimestampSchema,
});

export type ExportMessage = z.infer<typeof exportMessageSchema>;

export const exportJobScoreSchema = z.object({
  job: exportJobContextSchema,
  score: z.number(),
  reasons: z.array(z.string()),
  skill_gaps: z.array(z.string()),
  model_version: z.string(),
  scored_at: isoTimestampSchema,
});

export type ExportJobScore = z.infer<typeof exportJobScoreSchema>;

export const exportActivityEventSchema = z.object({
  event_id: uuidSchema,
  event_type: z.string(),
  organization_id: uuidSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
  occurred_at: isoTimestampSchema,
});

export type ExportActivityEvent = z.infer<typeof exportActivityEventSchema>;

/** A connection's bookkeeping. The credential reference is never exported. */
export const exportConnectedAccountSchema = z.object({
  connector_account_id: uuidSchema,
  organization_id: uuidSchema.nullable(),
  provider: z.string(),
  external_account_id: z.string(),
  scopes: z.array(z.string()),
  status: z.string(),
  consent_granted_at: isoTimestampSchema.nullable(),
  expires_at: isoTimestampSchema.nullable(),
  last_synced_at: isoTimestampSchema.nullable(),
  created_at: isoTimestampSchema,
});

export type ExportConnectedAccount = z.infer<typeof exportConnectedAccountSchema>;

export const accountExportSchema = z.object({
  export_version: z.literal(ACCOUNT_EXPORT_VERSION),
  generated_at: isoTimestampSchema,
  user: exportUserSchema,
  organization_memberships: z.array(exportMembershipSchema),
  student_records: z.array(exportStudentRecordSchema),
  resumes: z.array(exportResumeSchema),
  applications: z.array(exportApplicationSchema),
  messages: z.array(exportMessageSchema),
  job_scores: z.array(exportJobScoreSchema),
  activity_events: z.array(exportActivityEventSchema),
  connected_accounts: z.array(exportConnectedAccountSchema),
  truncated: z.array(exportTruncationSchema),
  notes: z.array(z.string()),
});

export type AccountExport = z.infer<typeof accountExportSchema>;

// --- deletion -----------------------------------------------------------------

/** The exact text a caller must send (and a person must type) to delete an account. */
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE' as const;

export const deleteAccountRequestSchema = z.strictObject({
  confirm: z.literal(DELETE_ACCOUNT_CONFIRMATION),
});

export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

export const deleteAccountResponseSchema = z.object({
  status: z.literal('deleted'),
  deleted_at: isoTimestampSchema,
  /** Organizations that had no other member and were deleted with the account. */
  organizations_deleted: z.number().int().min(0),
  /**
   * Stored resume files. They are removed after the database commit, on a best
   * effort basis: `failed` counts files whose removal reported an error.
   */
  resume_files: z.object({
    total: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
});

export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;

/**
 * Why a deletion was refused with 409 CONFLICT. Sent in `error.details.reason`
 * so a client can react without parsing the message.
 */
export const DELETE_ACCOUNT_BLOCKERS = ['sole_owner_of_organization', 'active_connected_accounts'] as const;
export const deleteAccountBlockerSchema = z.enum(DELETE_ACCOUNT_BLOCKERS);
export type DeleteAccountBlocker = z.infer<typeof deleteAccountBlockerSchema>;
