import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { employmentTypeSchema, resumeStatusSchema } from './enums.js';

/**
 * Normalized profile records produced by the resume parsing pipeline
 * (docs/01 § Primary flow, step 2). These are the canonical structures the
 * matching service consumes — connectors and parsers must map into them.
 */

export const dateRangeSchema = z.object({
  /** `YYYY-MM` — resumes rarely give a reliable day. */
  start: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullable(),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullable(),
  is_current: z.boolean(),
});

export type DateRange = z.infer<typeof dateRangeSchema>;

export const experienceEntrySchema = z.object({
  company: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  location: z.string().max(200).nullable(),
  employment_type: employmentTypeSchema,
  period: dateRangeSchema,
  highlights: z.array(z.string().min(1).max(1000)).max(50),
});

export type ExperienceEntry = z.infer<typeof experienceEntrySchema>;

export const educationEntrySchema = z.object({
  institution: z.string().min(1).max(200),
  degree: z.string().max(200).nullable(),
  field_of_study: z.string().max(200).nullable(),
  period: dateRangeSchema,
  gpa: z.number().min(0).max(10).nullable(),
});

export type EducationEntry = z.infer<typeof educationEntrySchema>;

export const skillSchema = z.object({
  /** Lowercased canonical form, e.g. `postgresql`. */
  name: z.string().min(1).max(80),
  /** Free-form label as it appeared in the source document. */
  raw: z.string().min(1).max(120),
  /** Months of demonstrated use, inferred from experience entries. */
  months_experience: z.number().int().min(0).nullable(),
});

export type Skill = z.infer<typeof skillSchema>;

export const contactDetailsSchema = z.object({
  email: z.email().nullable(),
  phone: z.string().max(40).nullable(),
  location: z.string().max(200).nullable(),
  links: z.array(z.url()).max(20),
});

export type ContactDetails = z.infer<typeof contactDetailsSchema>;

/** The full normalized profile extracted from one resume. */
export const parsedProfileSchema = z.object({
  full_name: z.string().max(200).nullable(),
  headline: z.string().max(300).nullable(),
  summary: z.string().max(4000).nullable(),
  contact: contactDetailsSchema,
  skills: z.array(skillSchema).max(300),
  experience: z.array(experienceEntrySchema).max(100),
  education: z.array(educationEntrySchema).max(50),
  certifications: z.array(z.string().min(1).max(300)).max(100),
  keywords: z.array(z.string().min(1).max(80)).max(400),
  total_months_experience: z.number().int().min(0),
});

export type ParsedProfile = z.infer<typeof parsedProfileSchema>;

export const resumeSchema = z.object({
  resume_id: uuidSchema,
  user_id: uuidSchema,
  storage_url: z.string().min(1),
  original_filename: z.string().min(1).max(400),
  content_type: z.string().min(1).max(200),
  byte_size: z.number().int().min(0),
  status: resumeStatusSchema,
  parsed_text: z.string().nullable(),
  parsed_profile: parsedProfileSchema.nullable(),
  /** 0–100. Populated by the ATS heuristics in the profile service. */
  ats_score: z.number().min(0).max(100).nullable(),
  embedding_id: z.string().nullable(),
  failure_reason: z.string().nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});

export type Resume = z.infer<typeof resumeSchema>;

/** Breakdown behind {@link Resume.ats_score}, surfaced to the user as advice. */
export const atsReportSchema = z.object({
  score: z.number().min(0).max(100),
  checks: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      passed: z.boolean(),
      weight: z.number().min(0).max(1),
      hint: z.string(),
    }),
  ),
});

export type AtsReport = z.infer<typeof atsReportSchema>;
