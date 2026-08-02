import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { employmentTypeSchema, jobSourceSchema, remoteTypeSchema } from './enums.js';

export const companySchema = z.object({
  company_id: uuidSchema,
  name: z.string().min(1).max(300),
  /** Lowercased, punctuation-stripped name used for dedupe joins. */
  normalized_name: z.string().min(1).max(300),
  industry: z.string().max(200).nullable(),
  website: z.url().nullable(),
  domain: z.string().max(255).nullable(),
  created_at: isoTimestampSchema,
});

export type Company = z.infer<typeof companySchema>;

export const salaryRangeSchema = z.object({
  min: z.number().int().min(0).nullable(),
  max: z.number().int().min(0).nullable(),
  currency: z.string().length(3).nullable(),
  period: z.enum(['hour', 'month', 'year']).nullable(),
});

export type SalaryRange = z.infer<typeof salaryRangeSchema>;

export const jobSchema = z.object({
  job_id: uuidSchema,
  company_id: uuidSchema,
  title: z.string().min(1).max(300),
  description: z.string().nullable(),
  salary_min: z.number().int().min(0).nullable(),
  salary_max: z.number().int().min(0).nullable(),
  salary_currency: z.string().length(3).nullable(),
  location: z.string().max(300).nullable(),
  remote_type: remoteTypeSchema,
  employment_type: employmentTypeSchema,
  source: jobSourceSchema,
  /** Stable id assigned by the upstream source, unique per source. */
  external_id: z.string().max(400).nullable(),
  apply_url: z.url().nullable(),
  /** Content fingerprint used for cross-source dedupe. Unique. */
  job_hash: z.string().length(64),
  skills: z.array(z.string().min(1).max(80)).max(200),
  posted_at: isoTimestampSchema.nullable(),
  expires_at: isoTimestampSchema.nullable(),
  is_active: z.boolean(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});

export type Job = z.infer<typeof jobSchema>;

/**
 * What a connector emits before normalization. Deliberately loose: upstream
 * feeds are messy, and the jobs service is responsible for coercing this into
 * a {@link Job}. Rejecting here would drop otherwise-usable listings.
 */
export const rawJobPostingSchema = z.object({
  source: jobSourceSchema,
  external_id: z.string().min(1).max(400).nullable(),
  title: z.string().min(1).max(500),
  company_name: z.string().min(1).max(300),
  company_website: z.string().max(500).nullable().optional(),
  description: z.string().max(200_000).nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  remote_type: z.string().max(50).nullable().optional(),
  employment_type: z.string().max(50).nullable().optional(),
  salary_text: z.string().max(300).nullable().optional(),
  salary_min: z.number().nullable().optional(),
  salary_max: z.number().nullable().optional(),
  salary_currency: z.string().max(10).nullable().optional(),
  apply_url: z.string().max(2000).nullable().optional(),
  posted_at: z.string().max(60).nullable().optional(),
});

export type RawJobPosting = z.infer<typeof rawJobPostingSchema>;

/** Outcome of running one connector pass, reported to analytics. */
export interface IngestionReport {
  source: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  errors: string[];
}

export const jobRecommendationSchema = z.object({
  job: jobSchema,
  score: z.number().min(0).max(1),
  reasons: z.array(z.string()).max(20),
});

export type JobRecommendation = z.infer<typeof jobRecommendationSchema>;
