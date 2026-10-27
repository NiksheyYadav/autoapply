import { z } from 'zod';
import { isoTimestampSchema, paginationQuerySchema, uuidSchema } from './common.js';
import { APPLICATION_STATUSES, applicationStatusSchema, type MemberRole } from './enums.js';

/**
 * Contracts for admin-service (docs/08: "college and enterprise operations"),
 * mounted under `/v1/admin/organizations/:orgId/…`.
 *
 * Who may call: an authenticated *member* of `:orgId` whose role is one of
 * {@link ADMIN_ROSTER_ROLES}, in an organization whose type is one of
 * {@link ADMIN_ROSTER_ORG_TYPES}. Anyone who is not a member of `:orgId` gets
 * 404 (the API never confirms an organization exists to outsiders); a member
 * with a lesser role, or a member of a non-university org, gets 403.
 *
 * Privacy rule (the one place it is defined; the service enforces it in SQL):
 * a roster row is *identity only* until the student is also a member of the
 * organization ("sharing enabled" — the same membership test jobs-service
 * applies before staff may see a member's recommendations). Only for such
 * students does staff see anything derived from the student's own activity:
 * application status counts and the latest ATS score. Resume text, parsed
 * profiles, cover letters, messages, contacts and job/employer names are never
 * returned by any endpoint here.
 */

export const ADMIN_ROSTER_ROLES = ['owner', 'admin'] as const satisfies readonly MemberRole[];
export type AdminRosterRole = (typeof ADMIN_ROSTER_ROLES)[number];

/**
 * Roster management is a university-pilot feature. Enterprise orgs are excluded
 * on purpose: an employer monitoring staff members' job search is a different
 * product with a different consent story. Widening this is a one-line change.
 */
export const ADMIN_ROSTER_ORG_TYPES = ['university'] as const;

/** Hard caps. Import: per request. Export: rows in one CSV download. */
export const ADMIN_MAX_IMPORT_ROWS = 5_000;
export const ADMIN_MAX_EXPORT_ROWS = 10_000;

export const adminOrgParamsSchema = z.object({ orgId: uuidSchema });
export type AdminOrgParams = z.infer<typeof adminOrgParamsSchema>;

export const adminStudentParamsSchema = z.object({ orgId: uuidSchema, studentId: uuidSchema });
export type AdminStudentParams = z.infer<typeof adminStudentParamsSchema>;

// --- shared building blocks --------------------------------------------------

/** One count per lifecycle status, zero-filled so clients never test for a missing key. */
export const applicationStatusCountsSchema = z.record(
  applicationStatusSchema,
  z.number().int().min(0),
);
export type ApplicationStatusCounts = z.infer<typeof applicationStatusCountsSchema>;

/**
 * What staff may see about a student's job search. `null` on a roster row means
 * "sharing not enabled" — it is not the same as zero activity.
 */
export const studentInsightsSchema = z.object({
  has_resume: z.boolean(),
  /** Latest parsed resume's ATS score (0–100), or null when none has been scored. */
  latest_ats_score: z.number().min(0).max(100).nullable(),
  /** Only applications made in this organization's context (applications.organization_id). */
  applications_total: z.number().int().min(0),
  applications_by_status: applicationStatusCountsSchema,
  last_application_activity_at: isoTimestampSchema.nullable(),
});
export type StudentInsights = z.infer<typeof studentInsightsSchema>;

export const rosterStudentSchema = z.object({
  student_id: uuidSchema,
  email: z.string().max(320),
  /** The platform account's name; null until sharing is enabled. */
  full_name: z.string().nullable(),
  /** Stored in `students.department`. */
  program: z.string().nullable(),
  graduation_year: z.number().int().nullable(),
  /** `students.current_status` (default `active`). */
  status: z.string(),
  created_at: isoTimestampSchema,
  /** True when the student is also a member of the organization. */
  sharing_enabled: z.boolean(),
  insights: studentInsightsSchema.nullable(),
});
export type RosterStudent = z.infer<typeof rosterStudentSchema>;

// --- GET …/students ------------------------------------------------------------

/**
 * `search` matches the email, and the name of students with sharing enabled
 * (so a search can never be used to probe names that are not shown).
 * `has_resume` / `application_status` only ever match students with sharing
 * enabled — for everyone else those attributes are unknown, not false.
 */
export const rosterFilterSchema = z.object({
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  has_resume: z.stringbool().optional(),
  application_status: applicationStatusSchema.optional(),
});
export type RosterFilter = z.infer<typeof rosterFilterSchema>;

export const listAdminStudentsQuerySchema = paginationQuerySchema.extend(rosterFilterSchema.shape);
export type ListAdminStudentsQuery = z.infer<typeof listAdminStudentsQuerySchema>;

export const listAdminStudentsResponseSchema = z.object({
  items: z.array(rosterStudentSchema),
  next_cursor: z.string().nullable(),
});
export type ListAdminStudentsResponse = z.infer<typeof listAdminStudentsResponseSchema>;

// --- GET …/students/:studentId -----------------------------------------------

export const adminStudentResponseSchema = z.object({ student: rosterStudentSchema });
export type AdminStudentResponse = z.infer<typeof adminStudentResponseSchema>;

// --- POST …/students/import --------------------------------------------------

/** Columns accepted in a CSV header (any order) and keys accepted in a JSON row. */
export const IMPORT_STUDENT_COLUMNS = [
  'email',
  'full_name',
  'student_id',
  'graduation_year',
  'program',
] as const;
export type ImportStudentColumn = (typeof IMPORT_STUDENT_COLUMNS)[number];

/** True when `value` contains a C0/C1 control character or DEL (tab, CR, LF included). */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const singleLineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !hasControlCharacters(value), 'Control characters are not allowed');

const graduationYearSchema = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^\d{4}$/),
  ])
  .transform((value) => Number(value))
  .pipe(z.number().int().min(1950).max(2100));

/**
 * One roster row. Strict: unknown keys are rejected. Emails are normalized
 * (trimmed, lower-cased) because that is the dedupe key. Blank optional values
 * are treated as absent by the service before this schema runs.
 */
export const importStudentRowSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  /** Validated but not stored: the platform account's own name is authoritative. */
  full_name: singleLineText(200),
  /** Validated but not stored: `students` has no column for an institution id (see service notes). */
  student_id: singleLineText(64).optional(),
  graduation_year: graduationYearSchema.optional(),
  /** Stored in `students.department`. */
  program: singleLineText(200).optional(),
});
export type ImportStudentRow = z.input<typeof importStudentRowSchema>;

/**
 * JSON body of `POST …/students/import` (`Content-Type: application/json`).
 * The same rows may instead be sent as a `text/csv` body whose first line is a
 * header naming {@link IMPORT_STUDENT_COLUMNS}. Requires an `Idempotency-Key`
 * header. The server validates rows one by one so a single bad row yields a
 * row-level error rather than a failed request.
 */
export const importStudentsRequestSchema = z.object({
  rows: z.array(importStudentRowSchema).min(1).max(ADMIN_MAX_IMPORT_ROWS),
});
export type ImportStudentsRequest = z.input<typeof importStudentsRequestSchema>;

/**
 * Closed vocabulary of per-row failures. Reasons never echo submitted values
 * (they may be personal data or attacker-controlled text).
 */
export const IMPORT_ROW_ERROR_REASONS = [
  'MALFORMED_ROW',
  'UNKNOWN_FIELD',
  'MISSING_EMAIL',
  'INVALID_EMAIL',
  'MISSING_FULL_NAME',
  'INVALID_FULL_NAME',
  'INVALID_STUDENT_ID',
  'INVALID_GRADUATION_YEAR',
  'INVALID_PROGRAM',
] as const;
export const importRowErrorReasonSchema = z.enum(IMPORT_ROW_ERROR_REASONS);
export type ImportRowErrorReason = z.infer<typeof importRowErrorReasonSchema>;

/**
 * Every data row lands in exactly one bucket, so
 * `created + updated + skipped + errors.length === total_rows`.
 * `row` is the 1-based position among data rows (a CSV header is not counted).
 *
 * `skipped` rows were valid but changed nothing:
 *  - `unchanged`: already on the roster with the same values (this is what an
 *    idempotent re-import reports);
 *  - `duplicate_in_file`: same normalized email as an earlier row (first wins);
 *  - `no_platform_account`: no Atlas account has this email. The `students`
 *    table requires a user, so an "invited" roster entry cannot be stored yet.
 *    Nobody is emailed; re-import after the student signs up.
 */
export const importStudentsResponseSchema = z.object({
  total_rows: z.number().int().min(0),
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  skipped: z.number().int().min(0),
  skipped_breakdown: z.object({
    unchanged: z.number().int().min(0),
    duplicate_in_file: z.number().int().min(0),
    no_platform_account: z.number().int().min(0),
  }),
  errors: z.array(z.object({ row: z.number().int().min(1), reason: importRowErrorReasonSchema })),
  /** Columns that were supplied in at least one valid row but are not persisted. */
  ignored_fields: z.array(z.enum(['full_name', 'student_id'])),
});
export type ImportStudentsResponse = z.infer<typeof importStudentsResponseSchema>;

// --- GET …/funnel --------------------------------------------------------------

/**
 * `from` is inclusive and `to` exclusive. The range scopes *activity* —
 * applications and resume uploads created inside it. Roster counts are always
 * as of now.
 */
export const adminFunnelQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(
    (range) =>
      range.from === undefined ||
      range.to === undefined ||
      Date.parse(range.from) < Date.parse(range.to),
    { message: '`from` must be earlier than `to`', path: ['from'] },
  );
export type AdminFunnelQuery = z.infer<typeof adminFunnelQuerySchema>;

export const adminFunnelResponseSchema = z.object({
  organization_id: uuidSchema,
  range: z.object({ from: isoTimestampSchema.nullable(), to: isoTimestampSchema.nullable() }),
  generated_at: isoTimestampSchema,
  roster: z.object({
    /** Every roster row, including students whose platform account was since deleted. */
    size: z.number().int().min(0),
    /**
     * Linked to a live platform account. Equal to `size` until invited-only
     * entries can be stored (they need a migration) or an account is deleted.
     */
    signed_up: z.number().int().min(0),
    /** Signed up and also a member of the organization. Everything below counts only these students. */
    sharing_enabled: z.number().int().min(0),
  }),
  resumes: z.object({
    students_with_resume: z.number().int().min(0),
    students_with_ats_score: z.number().int().min(0),
    /** Mean of each student's latest scored resume, one decimal; null when nobody has one. */
    avg_ats_score: z.number().min(0).max(100).nullable(),
  }),
  applications: z.object({
    total: z.number().int().min(0),
    students_applied: z.number().int().min(0),
    by_status: applicationStatusCountsSchema,
  }),
  offers: z.object({
    applications: z.number().int().min(0),
    students: z.number().int().min(0),
  }),
});
export type AdminFunnelResponse = z.infer<typeof adminFunnelResponseSchema>;

// --- GET …/export.csv ------------------------------------------------------------

export const exportStudentsQuerySchema = rosterFilterSchema.extend({
  /** Prefix the file with a UTF-8 byte-order mark so Excel opens it as UTF-8. Default true. */
  bom: z.stringbool().default(true),
});
export type ExportStudentsQuery = z.infer<typeof exportStudentsQuerySchema>;

/** Zero-filled status counts, in lifecycle order. */
export function emptyApplicationStatusCounts(): ApplicationStatusCounts {
  return Object.fromEntries(
    APPLICATION_STATUSES.map((status) => [status, 0]),
  ) as ApplicationStatusCounts;
}
