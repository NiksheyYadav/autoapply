import * as shared from '@atlas/types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as local from '../src/lib/contracts';

/**
 * src/lib/contracts.ts mirrors packages/types/src/admin.ts at runtime (a
 * Turbopack limitation explained in that file). These tests are the other half
 * of the drift guard: if the shared contract changes and the mirror does not,
 * they fail here instead of in a staff member's browser.
 */

const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'output' });

describe('mirrored constants', () => {
  it.each([
    ['ADMIN_ROSTER_ROLES'],
    ['ADMIN_MAX_IMPORT_ROWS'],
    ['ADMIN_MAX_EXPORT_ROWS'],
    ['APPLICATION_STATUSES'],
    ['IMPORT_STUDENT_COLUMNS'],
    ['IMPORT_ROW_ERROR_REASONS'],
  ] as const)('%s equals the shared value', (name) => {
    expect(local[name]).toEqual(shared[name]);
  });
});

describe('mirrored schemas', () => {
  it.each([
    ['uuidSchema'],
    ['listAdminStudentsResponseSchema'],
    ['importStudentsResponseSchema'],
    ['adminFunnelResponseSchema'],
  ] as const)('%s describes exactly the same JSON as the shared schema', (name) => {
    expect(jsonSchema(local[name])).toEqual(jsonSchema(shared[name]));
  });

  const orgId = '0b6d2a4e-6f43-4a39-9a43-4a1d3c1a8e11';
  const student = {
    student_id: orgId,
    email: 'a@uni.edu',
    full_name: null,
    program: 'Maths',
    graduation_year: 2027,
    status: 'active',
    created_at: '2026-10-27T12:00:00.000Z',
    sharing_enabled: false,
    insights: null,
  };

  const fixtures = [
    ['a valid roster page', 'listAdminStudentsResponseSchema', { items: [student], next_cursor: 'abc' }, true],
    ['an empty roster page', 'listAdminStudentsResponseSchema', { items: [], next_cursor: null }, true],
    ['a roster page with a non-uuid student id', 'listAdminStudentsResponseSchema', { items: [{ ...student, student_id: 'x' }], next_cursor: null }, false],
    ['a roster page with no cursor key', 'listAdminStudentsResponseSchema', { items: [] }, false],
    [
      'a valid import report',
      'importStudentsResponseSchema',
      {
        total_rows: 1,
        created: 1,
        updated: 0,
        skipped: 0,
        skipped_breakdown: { unchanged: 0, duplicate_in_file: 0, no_platform_account: 0 },
        errors: [],
        ignored_fields: [],
      },
      true,
    ],
    [
      'an import report with a free-text error reason',
      'importStudentsResponseSchema',
      {
        total_rows: 1,
        created: 0,
        updated: 0,
        skipped: 0,
        skipped_breakdown: { unchanged: 0, duplicate_in_file: 0, no_platform_account: 0 },
        errors: [{ row: 1, reason: 'jane@uni.edu is bad' }],
        ignored_fields: [],
      },
      false,
    ],
  ] as const;

  it.each(fixtures)('agrees with the shared schema on %s', (_label, name, payload, expected) => {
    expect(local[name].safeParse(payload).success).toBe(expected);
    expect(shared[name].safeParse(payload).success).toBe(expected);
  });
});
