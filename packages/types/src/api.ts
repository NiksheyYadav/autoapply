import { z } from 'zod';
import { paginationQuerySchema, uuidSchema } from './common.js';
import { applicationModeSchema, applicationStatusSchema, remoteTypeSchema } from './enums.js';
import { publicUserSchema } from './identity.js';
import { companySchema, jobRecommendationSchema, rawJobPostingSchema } from './job.js';
import { applicationSchema, contactSchema, messageSchema } from './application.js';
import { resumeSchema } from './profile.js';

/**
 * Request/response contracts for the public REST surface (docs/04). Services
 * import these rather than redeclaring shapes, which is what makes the
 * contract tests in docs/13 meaningful.
 */

// --- auth-service -----------------------------------------------------------

/**
 * 12 chars minimum rather than the usual 8: this platform holds resumes and
 * connector grants, and docs/09 classifies that as sensitive.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256);

export const registerRequestSchema = z.object({
  email: z.email(),
  password: passwordSchema,
  full_name: z.string().min(1).max(200),
  organization_name: z.string().min(1).max(200).optional(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refresh_token: z.string().min(16),
});

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const tokenPairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
});

export type TokenPair = z.infer<typeof tokenPairSchema>;

export const authSessionResponseSchema = z.object({
  user: publicUserSchema,
  organization_id: uuidSchema.nullable(),
  tokens: tokenPairSchema,
});

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

// --- profile-service --------------------------------------------------------

/**
 * `POST /v1/resumes` is `multipart/form-data`: the file itself is a part
 * named `file`, which Zod can't validate — this schema only covers the
 * accompanying non-file field.
 */
export const createResumeRequestSchema = z.object({
  source: z.enum(['upload', 'connector', 'import']).default('upload'),
});

export type CreateResumeRequest = z.infer<typeof createResumeRequestSchema>;

export const createResumeResponseSchema = z.object({
  resume_id: uuidSchema,
  status: resumeSchema.shape.status,
});

export type CreateResumeResponse = z.infer<typeof createResumeResponseSchema>;

export const resumeResponseSchema = z.object({
  resume: resumeSchema,
});

export type ResumeResponse = z.infer<typeof resumeResponseSchema>;

// --- jobs-service -----------------------------------------------------------

export const jobRecommendationsQuerySchema = paginationQuerySchema.extend({
  user_id: uuidSchema,
  location: z.string().max(200).optional(),
  remote_type: remoteTypeSchema.optional(),
});

export type JobRecommendationsQuery = z.infer<typeof jobRecommendationsQuerySchema>;

export const jobRecommendationsResponseSchema = z.object({
  items: z.array(jobRecommendationSchema),
  next_cursor: z.string().nullable(),
});

export type JobRecommendationsResponse = z.infer<typeof jobRecommendationsResponseSchema>;

export const ingestJobsRequestSchema = z.object({
  postings: z.array(rawJobPostingSchema).min(1).max(500),
});

export type IngestJobsRequest = z.infer<typeof ingestJobsRequestSchema>;

// --- applications-service ---------------------------------------------------

export const createApplicationRequestSchema = z.object({
  job_id: uuidSchema,
  resume_id: uuidSchema,
  mode: applicationModeSchema.default('manual'),
});

export type CreateApplicationRequest = z.infer<typeof createApplicationRequestSchema>;

export const applicationResponseSchema = z.object({
  application: applicationSchema,
});

export type ApplicationResponse = z.infer<typeof applicationResponseSchema>;

export const listApplicationsQuerySchema = paginationQuerySchema;
export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;

export const listApplicationsResponseSchema = z.object({
  items: z.array(applicationSchema),
  next_cursor: z.string().nullable(),
});

export type ListApplicationsResponse = z.infer<typeof listApplicationsResponseSchema>;

/** Appends one entry to an application's lifecycle trail (docs/02 § application_events). */
export const appendApplicationEventRequestSchema = z.object({
  to_status: applicationStatusSchema,
  note: z.string().max(2000).optional(),
});

export type AppendApplicationEventRequest = z.infer<typeof appendApplicationEventRequestSchema>;

// --- referrals-service --------------------------------------------------------

export const createContactRequestSchema = z.object({
  company_id: uuidSchema,
  full_name: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  email: z.email().optional(),
  linkedin_url: z.url().optional(),
});

export type CreateContactRequest = z.infer<typeof createContactRequestSchema>;

export const contactResponseSchema = z.object({ contact: contactSchema });
export type ContactResponse = z.infer<typeof contactResponseSchema>;

export const listContactsResponseSchema = z.object({
  items: z.array(contactSchema),
  next_cursor: z.string().nullable(),
});

export type ListContactsResponse = z.infer<typeof listContactsResponseSchema>;

/** One contact worth reaching out to, in the context of one of the caller's own applications. */
export const referralCandidateSchema = z.object({
  contact: contactSchema,
  company: companySchema,
  job_id: uuidSchema,
  application_id: uuidSchema,
});

export type ReferralCandidate = z.infer<typeof referralCandidateSchema>;

export const listReferralsResponseSchema = z.object({
  items: z.array(referralCandidateSchema),
});

export type ListReferralsResponse = z.infer<typeof listReferralsResponseSchema>;

// --- outreach-service ---------------------------------------------------------

export const createMessageRequestSchema = z.object({
  application_id: uuidSchema.nullable().default(null),
  contact_id: uuidSchema.nullable().default(null),
  channel: messageSchema.shape.channel,
  /** Auto-drafted from the application/contact context when omitted. */
  subject: z.string().max(400).optional(),
  body: z.string().min(1).max(10_000).optional(),
});

export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;

export const scheduleMessageRequestSchema = z.object({
  scheduled_for: z.iso.datetime(),
});

export type ScheduleMessageRequest = z.infer<typeof scheduleMessageRequestSchema>;

export const messageResponseSchema = z.object({ message: messageSchema });
export type MessageResponse = z.infer<typeof messageResponseSchema>;

export const listMessagesResponseSchema = z.object({
  items: z.array(messageSchema),
  next_cursor: z.string().nullable(),
});

export type ListMessagesResponse = z.infer<typeof listMessagesResponseSchema>;
