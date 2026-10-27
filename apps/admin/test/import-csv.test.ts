import { describe, expect, it } from 'vitest';
import {
  ADMIN_MAX_IMPORT_ROWS,
  IMPORT_ROW_ERROR_REASONS,
  IMPORT_STUDENT_COLUMNS,
  importStudentRowSchema,
  importStudentsResponseSchema,
  type ImportStudentsResponse,
} from '@atlas/types';
import { parseCsv } from '../src/lib/csv';
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  buildImportTemplate,
  checkImportFile,
  describeRowError,
  groupRowErrors,
  preflightCsv,
  summarizeImport,
} from '../src/lib/import-csv';

describe('the downloadable template', () => {
  const template = buildImportTemplate();

  it('has exactly the header the API accepts', () => {
    const [header] = parseCsv(template, { maxRecords: 10 });
    expect(header).toEqual([...IMPORT_STUDENT_COLUMNS]);
  });

  it('passes this console’s own pre-flight with one row and every column', () => {
    expect(preflightCsv(template)).toEqual({ ok: true, rowCount: 1, columns: [...IMPORT_STUDENT_COLUMNS] });
  });

  it('has an example row that the shared row schema (the API’s own) accepts', () => {
    const [header, row] = parseCsv(template, { maxRecords: 10 });
    expect(header).toBeDefined();
    const object = Object.fromEntries(header!.map((name, position) => [name, row?.[position]]));
    expect(importStudentRowSchema.safeParse(object).success).toBe(true);
  });

  it('uses a reserved example domain, never a plausible real address', () => {
    expect(template).toContain('@university.example');
  });

  it('mirrors the API row cap', () => {
    expect(MAX_IMPORT_ROWS).toBe(ADMIN_MAX_IMPORT_ROWS);
    expect(MAX_IMPORT_ROWS).toBe(5000);
  });
});

describe('checkImportFile', () => {
  const csv = { name: 'students.csv', size: 1200, type: 'text/csv' };

  it('accepts a normal CSV', () => {
    expect(checkImportFile(csv)).toEqual({ ok: true });
  });

  it.each([
    ['text/csv', 'students.csv'],
    ['', 'students.CSV'],
    ['application/vnd.ms-excel', 'export.csv'],
    ['text/plain', 'list.csv'],
  ])('accepts %j named %j', (type, name) => {
    expect(checkImportFile({ name, size: 10, type })).toEqual({ ok: true });
  });

  it.each(['students.xlsx', 'students.xls', 'students.txt', 'students', 'students.csv.exe', 'csv'])(
    'rejects the file name %j',
    (name) => {
      const result = checkImportFile({ name, size: 10, type: 'text/csv' });
      expect(result.ok).toBe(false);
    },
  );

  it('rejects a .csv name with a clearly different MIME type', () => {
    const result = checkImportFile({ name: 'a.csv', size: 10, type: 'application/pdf' });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects an empty file and one over the size cap, accepting exactly the cap', () => {
    expect(checkImportFile({ ...csv, size: 0 })).toMatchObject({ ok: false, message: expect.stringMatching(/empty/) });
    expect(checkImportFile({ ...csv, size: MAX_IMPORT_BYTES + 1 })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/limited to 4\.0 MB/),
    });
    expect(checkImportFile({ ...csv, size: MAX_IMPORT_BYTES })).toEqual({ ok: true });
  });
});

describe('preflightCsv', () => {
  const issueCode = (text: string) => {
    const result = preflightCsv(text);
    return result.ok ? 'ok' : result.issue.code;
  };

  it('counts data rows, not the header, and ignores blank lines', () => {
    const result = preflightCsv('email,full_name\r\na@x.edu,A\r\n\r\nb@x.edu,B\r\n,\r\n');
    expect(result).toEqual({ ok: true, rowCount: 2, columns: ['email', 'full_name'] });
  });

  it('accepts a BOM, any column order, and hand-edited header names', () => {
    const result = preflightCsv('﻿Full Name,Email\nA,a@x.edu\n');
    expect(result).toMatchObject({ ok: true, rowCount: 1, columns: ['full_name', 'email'] });
  });

  it('counts quoted fields that contain commas and newlines as one record', () => {
    const result = preflightCsv('email,full_name,program\na@x.edu,"Doe, Jane","Line one\nLine two"\n');
    expect(result).toMatchObject({ ok: true, rowCount: 1 });
  });

  it('reports each structural problem with its own code', () => {
    expect(issueCode('')).toBe('empty');
    expect(issueCode('\n\n  \n')).toBe('empty');
    expect(issueCode('email,full_name\n')).toBe('no_data_rows');
    expect(issueCode('email\na@x.edu\n')).toBe('header_missing');
    expect(issueCode('full_name\nA\n')).toBe('header_missing');
    expect(issueCode('email,full_name,nickname\na@x.edu,A,Al\n')).toBe('header_unknown');
    expect(issueCode('email,full_name,email\na@x.edu,A,b@x.edu\n')).toBe('header_duplicate');
    expect(issueCode('email,full_name\n"a@x.edu,A\n')).toBe('malformed');
    expect(issueCode('email,full_name\nab"c@x.edu,A\n"x"y,B\n')).toBe('malformed');
  });

  it('enforces the 5,000 row cap exactly', () => {
    const rows = (count: number) =>
      `email,full_name\n${Array.from({ length: count }, (_, i) => `s${i}@x.edu,S`).join('\n')}\n`;
    expect(preflightCsv(rows(ADMIN_MAX_IMPORT_ROWS))).toMatchObject({ ok: true, rowCount: ADMIN_MAX_IMPORT_ROWS });
    expect(issueCode(rows(ADMIN_MAX_IMPORT_ROWS + 1))).toBe('too_many_rows');
  });

  it('recognises a file with no header row without echoing the student’s email', () => {
    const result = preflightCsv('jane.doe@uni.edu,Jane Doe\nsam@uni.edu,Sam\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe('header_looks_like_data');
      expect(result.issue.message).not.toContain('jane.doe');
      expect(result.issue.message).toContain(IMPORT_STUDENT_COLUMNS.join(','));
    }
  });

  it('keeps unknown header names short and on one line when echoing them', () => {
    const result = preflightCsv(`email,full_name,${'x'.repeat(500)}\na@x.edu,A,1\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.message.length).toBeLessThan(300);
  });
});

describe('row errors', () => {
  it('has copy for every reason in the API vocabulary', () => {
    for (const reason of IMPORT_ROW_ERROR_REASONS) {
      expect(describeRowError(reason)).not.toBe('The row could not be used.');
    }
  });

  it('falls back to generic copy for a reason it does not know', () => {
    expect(describeRowError('SOMETHING_NEW')).toBe('The row could not be used.');
  });

  it('groups errors by reason, most frequent first', () => {
    const groups = groupRowErrors([
      { row: 1, reason: 'INVALID_EMAIL' },
      { row: 2, reason: 'MISSING_FULL_NAME' },
      { row: 3, reason: 'INVALID_EMAIL' },
      { row: 4, reason: 'INVALID_EMAIL' },
      { row: 9, reason: 'MISSING_FULL_NAME' },
    ]);
    expect(groups.map((group) => [group.reason, group.count])).toEqual([
      ['INVALID_EMAIL', 3],
      ['MISSING_FULL_NAME', 2],
    ]);
    expect(groups[0]?.description).toMatch(/email/i);
  });

  it('returns nothing for no errors', () => {
    expect(groupRowErrors([])).toEqual([]);
  });
});

describe('summarizeImport', () => {
  const base: ImportStudentsResponse = {
    total_rows: 10,
    created: 4,
    updated: 1,
    skipped: 3,
    skipped_breakdown: { unchanged: 1, duplicate_in_file: 1, no_platform_account: 1 },
    errors: [
      { row: 3, reason: 'INVALID_EMAIL' },
      { row: 8, reason: 'INVALID_GRADUATION_YEAR' },
    ],
    ignored_fields: ['full_name', 'student_id'],
  };

  const count = (summary: ReturnType<typeof summarizeImport>, key: string) =>
    summary.lines.find((line) => line.key === key)?.count;

  it('uses the API’s own numbers for every line', () => {
    const summary = summarizeImport(base, false);
    expect(count(summary, 'total')).toBe(10);
    expect(count(summary, 'created')).toBe(4);
    expect(count(summary, 'updated')).toBe(1);
    expect(count(summary, 'unchanged')).toBe(1);
    expect(count(summary, 'duplicates')).toBe(1);
    expect(count(summary, 'no_account')).toBe(1);
    expect(count(summary, 'errors')).toBe(2);
    expect(summary.outcome).toBe('imported');
    expect(summary.headline).toBe('Import finished: 4 added, 1 updated.');
  });

  it('says, truthfully, that nobody is invited when an account is missing', () => {
    const line = summarizeImport(base, false).lines.find((l) => l.key === 'no_account');
    expect(line?.explanation).toMatch(/Nobody was emailed or invited/);
    expect(line?.explanation).toMatch(/after they have signed up/);
  });

  it('explains which columns were validated but not stored', () => {
    const notes = summarizeImport(base, false).notes.join(' ');
    expect(notes).toMatch(/Names in the file were checked but not stored/);
    expect(notes).toMatch(/Student IDs in the file were checked but not stored/);
    expect(summarizeImport({ ...base, ignored_fields: [] }, false).notes).toEqual([]);
  });

  it('flags a replayed result so nobody thinks it ran twice', () => {
    expect(summarizeImport(base, true).notes[0]).toMatch(/Nothing was applied a second time/);
    expect(summarizeImport(base, false).notes.join(' ')).not.toMatch(/second time/);
  });

  it('calls out an import where no email has an account', () => {
    const summary = summarizeImport(
      {
        ...base,
        total_rows: 3,
        created: 0,
        updated: 0,
        skipped: 3,
        skipped_breakdown: { unchanged: 0, duplicate_in_file: 0, no_platform_account: 3 },
        errors: [],
        ignored_fields: ['full_name'],
      },
      false,
    );
    expect(summary.outcome).toBe('nothing_imported');
    expect(summary.headline).toMatch(/none of the emails has an Atlas account yet/);
  });

  it('calls out an import where every row has an error', () => {
    const summary = summarizeImport(
      {
        total_rows: 2,
        created: 0,
        updated: 0,
        skipped: 0,
        skipped_breakdown: { unchanged: 0, duplicate_in_file: 0, no_platform_account: 0 },
        errors: [
          { row: 1, reason: 'MISSING_EMAIL' },
          { row: 2, reason: 'MISSING_EMAIL' },
        ],
        ignored_fields: [],
      },
      false,
    );
    expect(summary.outcome).toBe('nothing_imported');
    expect(summary.headline).toBe('No rows were imported: all 2 rows have errors.');
  });

  it('reports an idempotent re-import as nothing to change', () => {
    const summary = summarizeImport(
      {
        total_rows: 5,
        created: 0,
        updated: 0,
        skipped: 5,
        skipped_breakdown: { unchanged: 5, duplicate_in_file: 0, no_platform_account: 0 },
        errors: [],
        ignored_fields: ['full_name'],
      },
      false,
    );
    expect(summary.outcome).toBe('nothing_changed');
    expect(summary.headline).toBe('Import finished: nothing needed to change.');
  });

  it('accepts the shape the API contract defines', () => {
    expect(importStudentsResponseSchema.safeParse(base).success).toBe(true);
  });
});
