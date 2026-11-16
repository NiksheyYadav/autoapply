import { describe, expect, it } from 'vitest';
import {
  ADMIN_MAX_IMPORT_ROWS,
  importStudentRowSchema,
  IMPORT_ROW_ERROR_REASONS,
} from '@atlas/types';
import {
  csvToRawRows,
  jsonToRawRows,
  planImport,
  validateImportRows,
} from '../src/lib/import-rows.js';

const reasons = (rows: unknown[]) =>
  validateImportRows(rows as never).map((outcome) => (outcome.ok ? 'ok' : outcome.reason));

describe('validateImportRows', () => {
  it('normalizes a valid row (trim, lower-case email, numeric year from text)', () => {
    const [outcome] = validateImportRows([
      {
        email: '  Ada.Lovelace@Uni.EDU ',
        full_name: ' Ada Lovelace ',
        graduation_year: '2027',
        program: ' Maths ',
      },
    ]);
    expect(outcome).toEqual({
      row: 1,
      ok: true,
      value: {
        row: 1,
        email: 'ada.lovelace@uni.edu',
        program: 'Maths',
        graduationYear: 2027,
        suppliedStudentId: false,
      },
    });
  });

  it('accepts a numeric graduation year and treats blank / null optional values as absent', () => {
    const outcomes = validateImportRows([
      { email: 'a@uni.edu', full_name: 'A', graduation_year: 2026, program: '', student_id: null },
      { email: 'b@uni.edu', full_name: 'B', graduation_year: '  ' },
    ]);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const first = outcomes[0];
    expect(first?.ok && first.value).toMatchObject({
      graduationYear: 2026,
      program: undefined,
      suppliedStudentId: false,
    });
  });

  it('reports a closed vocabulary of reasons, in column order', () => {
    expect(
      reasons([
        { full_name: 'No Email' },
        { email: 'not-an-email', full_name: 'Bad Email' },
        { email: 'a@uni.edu' },
        { email: 'b@uni.edu', full_name: 'x'.repeat(201) },
        { email: 'c@uni.edu', full_name: 'C', graduation_year: '20x6' },
        { email: 'd@uni.edu', full_name: 'D', graduation_year: 1900 },
        { email: 'e@uni.edu', full_name: 'E', graduation_year: 2026.5 },
        { email: 'f@uni.edu', full_name: 'F', program: 'x'.repeat(201) },
        { email: 'g@uni.edu', full_name: 'G', student_id: 'y'.repeat(65) },
        { email: 'h@uni.edu', full_name: 'H', surprise: 'x' },
        null,
        'a string',
        { email: ['a@uni.edu'], full_name: 'Array Email' },
        { email: 'i@uni.edu', full_name: { first: 'Obj' } },
      ]),
    ).toEqual([
      'MISSING_EMAIL',
      'INVALID_EMAIL',
      'MISSING_FULL_NAME',
      'INVALID_FULL_NAME',
      'INVALID_GRADUATION_YEAR',
      'INVALID_GRADUATION_YEAR',
      'INVALID_GRADUATION_YEAR',
      'INVALID_PROGRAM',
      'INVALID_STUDENT_ID',
      'UNKNOWN_FIELD',
      'MALFORMED_ROW',
      'MALFORMED_ROW',
      'INVALID_EMAIL',
      'INVALID_FULL_NAME',
    ]);
  });

  it('only ever produces reasons from the published list', () => {
    const outcomes = validateImportRows([null, {}, { email: 'x' }, { foo: 1 }] as never);
    for (const outcome of outcomes) {
      if (!outcome.ok) expect(IMPORT_ROW_ERROR_REASONS).toContain(outcome.reason);
    }
  });

  it('rejects control characters in text fields (CSV/line injection)', () => {
    expect(
      reasons([
        { email: 'a@uni.edu', full_name: 'Line\nBreak' },
        { email: 'b@uni.edu', full_name: 'Tab\tHere' },
        { email: 'c@uni.edu', full_name: 'Nul\u0000Byte' },
        { email: 'd@uni.edu', full_name: 'Ok', program: 'Carriage\rReturn' },
      ]),
    ).toEqual(['INVALID_FULL_NAME', 'INVALID_FULL_NAME', 'INVALID_FULL_NAME', 'INVALID_PROGRAM']);
  });

  it('never echoes submitted values in a reason', () => {
    const hostile = '<script>alert(1)</script>';
    const [outcome] = validateImportRows([{ email: hostile, full_name: 'X' }]);
    expect(JSON.stringify(outcome)).not.toContain('script');
  });

  it('rejects a __proto__ key as an unknown field without polluting anything', () => {
    const row = JSON.parse(
      '{"email":"a@uni.edu","full_name":"A","__proto__":{"admin":true}}',
    ) as Record<string, unknown>;
    expect(reasons([row])).toEqual(['UNKNOWN_FIELD']);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('keeps the exported strict row schema in step with the service', () => {
    expect(importStudentRowSchema.safeParse({ email: 'A@Uni.edu', full_name: 'A' }).data).toEqual({
      email: 'a@uni.edu',
      full_name: 'A',
    });
    expect(
      importStudentRowSchema.safeParse({ email: 'a@uni.edu', full_name: 'A', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('planImport', () => {
  it('dedupes by normalized email (first wins), keeps file order and reports ignored fields', () => {
    const plan = planImport(
      validateImportRows([
        { email: 'a@uni.edu', full_name: 'A', student_id: 'S1' },
        { email: 'B@uni.edu', full_name: 'B' },
        { email: ' A@UNI.edu', full_name: 'A again', program: 'Later' },
        { email: 'broken', full_name: 'X' },
      ]),
    );
    expect(plan.rows.map((row) => row.email)).toEqual(['a@uni.edu', 'b@uni.edu']);
    expect(plan.rows[0]?.program).toBeUndefined();
    expect(plan.duplicates).toBe(1);
    expect(plan.errors).toEqual([{ row: 4, reason: 'INVALID_EMAIL' }]);
    expect(plan.ignoredFields).toEqual(['full_name', 'student_id']);
  });

  it('does not reserve an email for an invalid row', () => {
    const plan = planImport(
      validateImportRows([
        { email: 'a@uni.edu', full_name: 'A', graduation_year: 1800 },
        { email: 'a@uni.edu', full_name: 'A' },
      ]),
    );
    expect(plan.rows).toHaveLength(1);
    expect(plan.duplicates).toBe(0);
  });

  it('reports no ignored fields when no row was valid', () => {
    expect(planImport(validateImportRows([{ email: 'x' }])).ignoredFields).toEqual([]);
  });
});

describe('csvToRawRows', () => {
  it('maps header names (case, spaces, hyphens, any order) onto canonical columns', () => {
    const rows = csvToRawRows('Full Name,EMAIL,graduation-year\nAda,ada@uni.edu,2027\n');
    expect(rows).toEqual([{ full_name: 'Ada', email: 'ada@uni.edu', graduation_year: '2027' }]);
  });

  it('tolerates a BOM, CRLF, quoted fields and trailing empty cells', () => {
    const rows = csvToRawRows('﻿email,full_name\r\n"a@uni.edu","Lovelace, Ada",,\r\n');
    expect(rows).toEqual([{ email: 'a@uni.edu', full_name: 'Lovelace, Ada' }]);
  });

  it('flags a row with extra non-empty cells as malformed instead of misaligning it', () => {
    const rows = csvToRawRows('email,full_name\na@uni.edu,A,surprise\nb@uni.edu,B\n');
    expect(rows[0]).toBeNull();
    expect(rows[1]).toEqual({ email: 'b@uni.edu', full_name: 'B' });
  });

  it('rejects the whole file for structural problems', () => {
    const fail = (csv: string) => () => csvToRawRows(csv);
    expect(fail('')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(fail('email,full_name\n')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(fail('email\na@uni.edu\n')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(fail('email,full_name,password\na@uni.edu,A,x\n')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(fail('email,email,full_name\na@uni.edu,a@uni.edu,A\n')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(fail('email,full_name\n"a@uni.edu,A\n')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('echoes only a bounded, defanged list of unknown header names', () => {
    try {
      csvToRawRows(`email,full_name,${'x'.repeat(500)}\u0007\na@uni.edu,A,1\n`);
      expect.unreachable();
    } catch (error) {
      const details = (error as { details: { unknown_columns: string[] } }).details;
      expect(details.unknown_columns[0]).toHaveLength(40);
    }
  });

  it(`accepts exactly ${ADMIN_MAX_IMPORT_ROWS} data rows and rejects one more with PAYLOAD_TOO_LARGE`, () => {
    const make = (count: number) =>
      `email,full_name\n${Array.from({ length: count }, (_, i) => `u${i}@uni.edu,U${i}`).join('\n')}\n`;
    expect(csvToRawRows(make(ADMIN_MAX_IMPORT_ROWS))).toHaveLength(ADMIN_MAX_IMPORT_ROWS);
    expect(() => csvToRawRows(make(ADMIN_MAX_IMPORT_ROWS + 1))).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
  });
});

describe('jsonToRawRows', () => {
  it('accepts { rows: [...] } and a bare array', () => {
    const row = { email: 'a@uni.edu', full_name: 'A' };
    expect(jsonToRawRows({ rows: [row] })).toEqual([row]);
    expect(jsonToRawRows([row])).toEqual([row]);
  });

  it('turns non-object rows into malformed placeholders instead of failing the request', () => {
    expect(
      jsonToRawRows({ rows: [null, 5, 'x', [], { email: 'a@uni.edu', full_name: 'A' }] }),
    ).toEqual([null, null, null, null, { email: 'a@uni.edu', full_name: 'A' }]);
  });

  it('rejects a bad envelope', () => {
    const fail = (body: unknown) => () => jsonToRawRows(body);
    expect(fail({})).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(fail({ rows: 'nope' })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(fail({ rows: [], extra: 1 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(fail({ rows: [] })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(fail('rows')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('rejects more than the row cap with PAYLOAD_TOO_LARGE', () => {
    const rows = Array.from({ length: ADMIN_MAX_IMPORT_ROWS + 1 }, () => ({
      email: 'a@uni.edu',
      full_name: 'A',
    }));
    expect(() => jsonToRawRows({ rows })).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
    expect(jsonToRawRows({ rows: rows.slice(1) })).toHaveLength(ADMIN_MAX_IMPORT_ROWS);
  });
});
