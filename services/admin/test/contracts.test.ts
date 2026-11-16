import { describe, expect, it } from 'vitest';
import {
  ADMIN_MAX_IMPORT_ROWS,
  adminFunnelQuerySchema,
  adminOrgParamsSchema,
  adminStudentParamsSchema,
  emptyApplicationStatusCounts,
  exportStudentsQuerySchema,
  importStudentsRequestSchema,
  importStudentsResponseSchema,
  listAdminStudentsQuerySchema,
  APPLICATION_STATUSES,
} from '@atlas/types';

// The schemas other code (the admin UI) consumes. These pin the wire contract.
describe('admin contracts', () => {
  it('validates :orgId and :studentId as UUIDs', () => {
    const id = '0b6d2a4e-6f43-4a39-9a43-4a1d3c1a8e11';
    expect(adminOrgParamsSchema.safeParse({ orgId: id }).success).toBe(true);
    expect(adminOrgParamsSchema.safeParse({ orgId: 'nope' }).success).toBe(false);
    expect(adminStudentParamsSchema.safeParse({ orgId: id, studentId: id }).success).toBe(true);
    expect(adminStudentParamsSchema.safeParse({ orgId: id, studentId: '1' }).success).toBe(false);
  });

  it('accepts a roster request of 1..5000 well-formed rows and rejects anything else', () => {
    const row = {
      email: 'Ada@Uni.edu',
      full_name: 'Ada',
      graduation_year: '2027',
      program: 'Maths',
    };
    const parsed = importStudentsRequestSchema.safeParse({ rows: [row] });
    expect(parsed.success && parsed.data.rows[0]).toMatchObject({
      email: 'ada@uni.edu',
      graduation_year: 2027,
    });
    expect(importStudentsRequestSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(
      importStudentsRequestSchema.safeParse({
        rows: Array.from({ length: ADMIN_MAX_IMPORT_ROWS + 1 }, () => row),
      }).success,
    ).toBe(false);
    expect(importStudentsRequestSchema.safeParse({ rows: [{ ...row, extra: 1 }] }).success).toBe(
      false,
    );
    expect(
      importStudentsRequestSchema.safeParse({ rows: [{ full_name: 'No Email' }] }).success,
    ).toBe(false);
  });

  it('describes the import report', () => {
    expect(
      importStudentsResponseSchema.safeParse({
        total_rows: 3,
        created: 1,
        updated: 0,
        skipped: 1,
        skipped_breakdown: { unchanged: 0, duplicate_in_file: 1, no_platform_account: 0 },
        errors: [{ row: 3, reason: 'INVALID_EMAIL' }],
        ignored_fields: ['full_name'],
      }).success,
    ).toBe(true);
    expect(
      importStudentsResponseSchema.safeParse({
        total_rows: 1,
        created: 0,
        updated: 0,
        skipped: 0,
        skipped_breakdown: { unchanged: 0, duplicate_in_file: 0, no_platform_account: 0 },
        errors: [{ row: 1, reason: 'free text with a@b.test in it' }],
        ignored_fields: [],
      }).success,
    ).toBe(false);
  });

  it('coerces and bounds list query parameters', () => {
    expect(listAdminStudentsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(
      listAdminStudentsQuerySchema.parse({
        limit: '50',
        search: ' ada ',
        has_resume: 'true',
        application_status: 'offer',
      }),
    ).toEqual({ limit: 50, search: 'ada', has_resume: true, application_status: 'offer' });
    expect(listAdminStudentsQuerySchema.parse({ search: '' }).search).toBeUndefined();
    expect(listAdminStudentsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listAdminStudentsQuerySchema.safeParse({ application_status: 'hired' }).success).toBe(
      false,
    );
    expect(listAdminStudentsQuerySchema.safeParse({ search: 'x'.repeat(201) }).success).toBe(false);
  });

  it('defaults the export BOM on and validates the funnel range', () => {
    expect(exportStudentsQuerySchema.parse({}).bom).toBe(true);
    expect(exportStudentsQuerySchema.parse({ bom: 'false' }).bom).toBe(false);
    expect(adminFunnelQuerySchema.safeParse({}).success).toBe(true);
    expect(
      adminFunnelQuerySchema.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' })
        .success,
    ).toBe(true);
    expect(
      adminFunnelQuerySchema.safeParse({ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });

  it('builds zero-filled status counts for every real application status', () => {
    const counts = emptyApplicationStatusCounts();
    expect(Object.keys(counts)).toEqual([...APPLICATION_STATUSES]);
    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
  });
});
