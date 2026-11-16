import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import {
  applicationModeSchema,
  applicationStatusSchema,
  employmentTypeSchema,
  messageChannelSchema,
  messageStatusSchema,
  remoteTypeSchema,
  taskStatusSchema,
} from './enums.js';

export const applicationSchema = z.object({
  application_id: uuidSchema,
  user_id: uuidSchema,
  job_id: uuidSchema,
  resume_id: uuidSchema.nullable(),
  organization_id: uuidSchema.nullable(),
  status: applicationStatusSchema,
  mode: applicationModeSchema,
  /** Required on submission so retries can never double-apply (docs/04). */
  idempotency_key: z.string().min(8).max(200),
  submitted_at: isoTimestampSchema.nullable(),
  last_event_at: isoTimestampSchema,
  failure_reason: z.string().nullable(),
  created_at: isoTimestampSchema,
});

export type Application = z.infer<typeof applicationSchema>;

/**
 * The slice of a job an application's *owner* needs to recognise it and to
 * continue on the employer's site (assisted apply). Deliberately small: no
 * description, salary or skills — those stay on the jobs-service surface.
 */
export const applicationJobSummarySchema = z.object({
  job_id: uuidSchema,
  title: z.string().min(1).max(300),
  company_id: uuidSchema,
  company_name: z.string().min(1).max(300),
  location: z.string().max(300).nullable(),
  remote_type: remoteTypeSchema,
  employment_type: employmentTypeSchema,
  /**
   * Safe to use as a link target: the service only ever returns http(s) URLs
   * (anything else a connector stored becomes null).
   */
  apply_url: z.url({ protocol: /^https?$/ }).nullable(),
  is_active: z.boolean(),
});

export type ApplicationJobSummary = z.infer<typeof applicationJobSummarySchema>;

/**
 * An application as its owner sees it. `job` is null when the job (or its
 * company) no longer exists. Organization staff never receive this shape: their
 * view is {@link applicationSchema} only, with no job or employer fields.
 */
export const applicationWithJobSchema = applicationSchema.extend({
  job: applicationJobSummarySchema.nullable(),
});

export type ApplicationWithJob = z.infer<typeof applicationWithJobSchema>;

export const contactSchema = z.object({
  contact_id: uuidSchema,
  company_id: uuidSchema,
  full_name: z.string().max(200).nullable(),
  title: z.string().max(200).nullable(),
  email: z.email().nullable(),
  linkedin_url: z.url().nullable(),
  /** 0–1 fit score from the referral service. */
  relevance_score: z.number().min(0).max(1).nullable(),
  created_at: isoTimestampSchema,
});

export type Contact = z.infer<typeof contactSchema>;

export const messageSchema = z.object({
  message_id: uuidSchema,
  application_id: uuidSchema.nullable(),
  contact_id: uuidSchema.nullable(),
  user_id: uuidSchema,
  channel: messageChannelSchema,
  status: messageStatusSchema,
  subject: z.string().max(400).nullable(),
  body: z.string(),
  idempotency_key: z.string().min(8).max(200),
  scheduled_for: isoTimestampSchema.nullable(),
  sent_at: isoTimestampSchema.nullable(),
  created_at: isoTimestampSchema,
});

export type Message = z.infer<typeof messageSchema>;

/**
 * Durable task record backing the queue layer. RabbitMQ carries the message;
 * this table is the audit trail and the source of truth for retries and DLQ
 * inspection (docs/06 § Processing rules).
 */
export const taskSchema = z.object({
  task_id: uuidSchema,
  task_type: z.string().min(1).max(120),
  queue_status: taskStatusSchema,
  retry_count: z.number().int().min(0),
  max_retries: z.number().int().min(0),
  payload: z.record(z.string(), z.unknown()),
  last_error: z.string().nullable(),
  locked_at: isoTimestampSchema.nullable(),
  locked_by: z.string().max(200).nullable(),
  available_at: isoTimestampSchema,
  created_at: isoTimestampSchema,
});

export type Task = z.infer<typeof taskSchema>;

export const analyticsEventSchema = z.object({
  event_id: uuidSchema,
  organization_id: uuidSchema.nullable(),
  user_id: uuidSchema.nullable(),
  event_type: z.string().min(1).max(120),
  payload: z.record(z.string(), z.unknown()),
  timestamp: isoTimestampSchema,
});

export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;
