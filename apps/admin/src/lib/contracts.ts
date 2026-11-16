import type {
  AdminFunnelResponse,
  ApplicationStatus,
  ImportRowErrorReason,
  ImportStudentColumn,
  ImportStudentsResponse,
  ListAdminStudentsResponse,
  MemberRole,
} from '@atlas/types';
import { z } from 'zod';

/**
 * Runtime copies of the admin-service contracts in packages/types/src/admin.ts.
 *
 * Why copies: @atlas/types writes its relative imports NodeNext-style
 * (`./admin.js`), and Turbopack, the Next 16 default bundler, cannot resolve
 * those to the `.ts` sources, so *runtime* imports from @atlas/types fail the
 * build (type-only imports are erased and are fine). Same trade-off as the
 * other service mirrors in lib/services.
 *
 * Drift is guarded twice:
 *  - at compile time, the assertions at the bottom of this file fail
 *    `tsc` if a schema here stops being assignable to the shared type;
 *  - at test time, test/contracts.test.ts compares every constant here with
 *    the real one and compares the schemas as JSON Schema.
 */

// --- enums and limits ----------------------------------------------------------------

export const ADMIN_ROSTER_ROLES = ['owner', 'admin'] as const satisfies readonly MemberRole[];

export const ADMIN_MAX_IMPORT_ROWS = 5_000;
export const ADMIN_MAX_EXPORT_ROWS = 10_000;

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
] as const satisfies readonly ApplicationStatus[];

export const IMPORT_STUDENT_COLUMNS = [
  'email',
  'full_name',
  'student_id',
  'graduation_year',
  'program',
] as const satisfies readonly ImportStudentColumn[];

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
] as const satisfies readonly ImportRowErrorReason[];

// --- schemas ---------------------------------------------------------------------------

export const uuidSchema = z.uuid();
const isoTimestampSchema = z.iso.datetime();
const applicationStatusSchema = z.enum(APPLICATION_STATUSES);
const importRowErrorReasonSchema = z.enum(IMPORT_ROW_ERROR_REASONS);
const count = z.number().int().min(0);

const applicationStatusCountsSchema = z.record(applicationStatusSchema, count);

const studentInsightsSchema = z.object({
  has_resume: z.boolean(),
  latest_ats_score: z.number().min(0).max(100).nullable(),
  applications_total: count,
  applications_by_status: applicationStatusCountsSchema,
  last_application_activity_at: isoTimestampSchema.nullable(),
});

const rosterStudentSchema = z.object({
  student_id: uuidSchema,
  email: z.string().max(320),
  full_name: z.string().nullable(),
  program: z.string().nullable(),
  graduation_year: z.number().int().nullable(),
  status: z.string(),
  created_at: isoTimestampSchema,
  sharing_enabled: z.boolean(),
  insights: studentInsightsSchema.nullable(),
});

/** Response of `GET …/students`. */
export const listAdminStudentsResponseSchema = z.object({
  items: z.array(rosterStudentSchema),
  next_cursor: z.string().nullable(),
});

/** Response of `POST …/students/import`. */
export const importStudentsResponseSchema = z.object({
  total_rows: count,
  created: count,
  updated: count,
  skipped: count,
  skipped_breakdown: z.object({
    unchanged: count,
    duplicate_in_file: count,
    no_platform_account: count,
  }),
  errors: z.array(z.object({ row: z.number().int().min(1), reason: importRowErrorReasonSchema })),
  ignored_fields: z.array(z.enum(['full_name', 'student_id'])),
});

/** Response of `GET …/funnel`. */
export const adminFunnelResponseSchema = z.object({
  organization_id: uuidSchema,
  range: z.object({ from: isoTimestampSchema.nullable(), to: isoTimestampSchema.nullable() }),
  generated_at: isoTimestampSchema,
  roster: z.object({ size: count, signed_up: count, sharing_enabled: count }),
  resumes: z.object({
    students_with_resume: count,
    students_with_ats_score: count,
    avg_ats_score: z.number().min(0).max(100).nullable(),
  }),
  applications: z.object({
    total: count,
    students_applied: count,
    by_status: applicationStatusCountsSchema,
  }),
  offers: z.object({ applications: count, students: count }),
});

// --- compile-time drift guard ------------------------------------------------------------

type Assignable<From, To> = [From] extends [To] ? true : never;

/** If any of these stops compiling, a schema above no longer produces the shared type. */
export const CONTRACT_ASSIGNABILITY: [
  Assignable<z.infer<typeof listAdminStudentsResponseSchema>, ListAdminStudentsResponse>,
  Assignable<ListAdminStudentsResponse, z.infer<typeof listAdminStudentsResponseSchema>>,
  Assignable<z.infer<typeof importStudentsResponseSchema>, ImportStudentsResponse>,
  Assignable<ImportStudentsResponse, z.infer<typeof importStudentsResponseSchema>>,
  Assignable<z.infer<typeof adminFunnelResponseSchema>, AdminFunnelResponse>,
  Assignable<AdminFunnelResponse, z.infer<typeof adminFunnelResponseSchema>>,
] = [true, true, true, true, true, true];
