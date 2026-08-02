import { z } from 'zod';

/**
 * Enum values are declared once here and reused by the Drizzle schema so the
 * database and the API can never drift apart.
 */

export const ORGANIZATION_TYPES = ['individual', 'university', 'enterprise'] as const;
export const organizationTypeSchema = z.enum(ORGANIZATION_TYPES);
export type OrganizationType = z.infer<typeof organizationTypeSchema>;

export const ORGANIZATION_PLANS = ['free', 'pro', 'campus', 'enterprise'] as const;
export const organizationPlanSchema = z.enum(ORGANIZATION_PLANS);
export type OrganizationPlan = z.infer<typeof organizationPlanSchema>;

/** RBAC roles (docs/09 § Controls). Ordered least → most privileged. */
export const MEMBER_ROLES = ['member', 'student', 'recruiter', 'admin', 'owner'] as const;
export const memberRoleSchema = z.enum(MEMBER_ROLES);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const AUTH_PROVIDERS = ['password', 'google', 'microsoft', 'saml'] as const;
export const authProviderSchema = z.enum(AUTH_PROVIDERS);
export type AuthProvider = z.infer<typeof authProviderSchema>;

export const REMOTE_TYPES = ['onsite', 'hybrid', 'remote', 'unknown'] as const;
export const remoteTypeSchema = z.enum(REMOTE_TYPES);
export type RemoteType = z.infer<typeof remoteTypeSchema>;

export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'internship',
  'unknown',
] as const;
export const employmentTypeSchema = z.enum(EMPLOYMENT_TYPES);
export type EmploymentType = z.infer<typeof employmentTypeSchema>;

export const RESUME_STATUSES = ['pending', 'processing', 'parsed', 'failed'] as const;
export const resumeStatusSchema = z.enum(RESUME_STATUSES);
export type ResumeStatus = z.infer<typeof resumeStatusSchema>;

/** Application lifecycle (docs/08 § applications-service). */
export const APPLICATION_STATUSES = [
  'draft',
  'queued',
  'submitting',
  'submitted',
  'acknowledged',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
  'failed',
] as const;
export const applicationStatusSchema = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;

export const APPLICATION_MODES = ['auto', 'manual', 'review'] as const;
export const applicationModeSchema = z.enum(APPLICATION_MODES);
export type ApplicationMode = z.infer<typeof applicationModeSchema>;

export const MESSAGE_CHANNELS = ['email', 'linkedin', 'sms', 'in_app'] as const;
export const messageChannelSchema = z.enum(MESSAGE_CHANNELS);
export type MessageChannel = z.infer<typeof messageChannelSchema>;

export const MESSAGE_STATUSES = [
  'draft',
  'scheduled',
  'sent',
  'delivered',
  'replied',
  'bounced',
  'failed',
] as const;
export const messageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const TASK_STATUSES = [
  'pending',
  'locked',
  'succeeded',
  'failed',
  'dead_lettered',
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Job sources are connectors; the list is open-ended but validated. */
export const JOB_SOURCES = ['manual', 'seed', 'greenhouse', 'lever', 'ashby', 'rss'] as const;
export const jobSourceSchema = z.enum(JOB_SOURCES);
export type JobSource = z.infer<typeof jobSourceSchema>;
