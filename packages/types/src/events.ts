import { z } from 'zod';
import { isoTimestampSchema, traceContextSchema, uuidSchema } from './common.js';
import { applicationStatusSchema, messageChannelSchema } from './enums.js';

/**
 * The durable event backbone (docs/06 § Event types). Every cross-service
 * workflow is driven by one of these — services never call each other
 * synchronously for writes.
 */
export const EVENT_TYPES = [
  'resume.parsed',
  'job.discovered',
  'job.scored',
  'application.created',
  'application.submitted',
  'outreach.sent',
  'referral.detected',
  'learning.updated',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const eventTypeSchema = z.enum(EVENT_TYPES);

const payloads = {
  'resume.parsed': z.object({
    resume_id: uuidSchema,
    user_id: uuidSchema,
    ats_score: z.number().min(0).max(100).nullable(),
    skill_count: z.number().int().min(0),
    total_months_experience: z.number().int().min(0),
  }),
  'job.discovered': z.object({
    job_id: uuidSchema,
    company_id: uuidSchema,
    source: z.string(),
    job_hash: z.string(),
    title: z.string(),
  }),
  'job.scored': z.object({
    job_id: uuidSchema,
    user_id: uuidSchema,
    score: z.number().min(0).max(1),
    model_version: z.string(),
  }),
  'application.created': z.object({
    application_id: uuidSchema,
    user_id: uuidSchema,
    job_id: uuidSchema,
    mode: z.string(),
  }),
  'application.submitted': z.object({
    application_id: uuidSchema,
    user_id: uuidSchema,
    job_id: uuidSchema,
    status: applicationStatusSchema,
  }),
  'outreach.sent': z.object({
    message_id: uuidSchema,
    user_id: uuidSchema,
    contact_id: uuidSchema.nullable(),
    channel: messageChannelSchema,
  }),
  'referral.detected': z.object({
    contact_id: uuidSchema,
    company_id: uuidSchema,
    user_id: uuidSchema,
    relevance_score: z.number().min(0).max(1),
  }),
  'learning.updated': z.object({
    model_version: z.string(),
    samples: z.number().int().min(0),
    metric: z.string(),
    value: z.number(),
  }),
} as const;

export type EventPayloadMap = {
  [K in EventType]: z.infer<(typeof payloads)[K]>;
};

/**
 * Envelope wrapping every message. `event_id` doubles as the idempotency key
 * for consumers, so republishing the same envelope is always safe.
 */
export interface EventEnvelope<K extends EventType = EventType> {
  event_id: string;
  event_type: K;
  occurred_at: string;
  trace: z.infer<typeof traceContextSchema>;
  payload: EventPayloadMap[K];
}

export const eventEnvelopeSchema = z.object({
  event_id: uuidSchema,
  event_type: eventTypeSchema,
  occurred_at: isoTimestampSchema,
  trace: traceContextSchema,
  payload: z.unknown(),
});

/** Validates the payload against the schema for its own `event_type`. */
export function parseEvent<K extends EventType>(input: unknown): EventEnvelope<K> {
  const envelope = eventEnvelopeSchema.parse(input);
  const payloadSchema = payloads[envelope.event_type];
  const payload = payloadSchema.parse(envelope.payload);
  return { ...envelope, payload } as EventEnvelope<K>;
}

export function eventPayloadSchema<K extends EventType>(type: K): (typeof payloads)[K] {
  return payloads[type];
}
