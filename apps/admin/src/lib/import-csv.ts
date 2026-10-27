import type { ImportRowErrorReason, ImportStudentColumn, ImportStudentsResponse } from '@atlas/types';
import { ADMIN_MAX_IMPORT_ROWS, IMPORT_ROW_ERROR_REASONS, IMPORT_STUDENT_COLUMNS } from './contracts';
import { CsvParseError, parseCsv } from './csv';
import { formatBytes, formatInt } from './format';

// --- limits -------------------------------------------------------------------

export const MAX_IMPORT_ROWS = ADMIN_MAX_IMPORT_ROWS;

/**
 * Largest request body the API reads for an import (services/admin
 * IMPORT_BODY_LIMIT_BYTES; Vercel rejects bodies over 4.5 MB regardless).
 * That constant is not in @atlas/types, so it is mirrored here.
 */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

const REQUIRED_COLUMNS: readonly ImportStudentColumn[] = ['email', 'full_name'];
const KNOWN_COLUMNS: ReadonlySet<string> = new Set(IMPORT_STUDENT_COLUMNS);

export const COLUMN_REFERENCE: readonly {
  column: ImportStudentColumn;
  required: boolean;
  notes: string;
}[] = [
  {
    column: 'email',
    required: true,
    notes:
      "The student's email address. It is the match key: a row is added only if an Atlas account with this email exists.",
  },
  {
    column: 'full_name',
    required: true,
    notes:
      'Checked, then discarded. A student’s name on the roster comes from their own Atlas account, not from this file.',
  },
  {
    column: 'student_id',
    required: false,
    notes: 'Up to 64 characters. Checked, then discarded: the roster has nowhere to store an institution ID yet.',
  },
  {
    column: 'graduation_year',
    required: false,
    notes: 'A four-digit year from 1950 to 2100. Leaving it blank keeps whatever is already stored.',
  },
  {
    column: 'program',
    required: false,
    notes: 'Up to 200 characters. Stored as the student’s program. Leaving it blank keeps whatever is already stored.',
  },
];

// --- template -------------------------------------------------------------------

export const IMPORT_TEMPLATE_FILENAME = 'atlas-roster-template.csv';

/**
 * The downloadable template: the exact header the API accepts, plus one clearly
 * fictional row (a reserved `.example` domain) to show the format. Importing it
 * unchanged is harmless: no Atlas account has that address, so the row is
 * skipped.
 */
export function buildImportTemplate(): string {
  const header = IMPORT_STUDENT_COLUMNS.join(',');
  const example = ['jordan.sample@university.example', 'Jordan Sample', 'S0000000', '2027', 'Computer Science'];
  return `${header}\r\n${example.join(',')}\r\n`;
}

// --- file checks (before reading the file) ---------------------------------------

export type FileCheck = { ok: true } | { ok: false; message: string };

const ACCEPTED_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/csv',
  'application/csv',
  'text/x-csv',
  'text/comma-separated-values',
  // Windows reports CSV files as Excel documents when Excel is installed.
  'application/vnd.ms-excel',
  'text/plain',
]);

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

/** Cheap checks on the file's metadata, run before its contents are read. */
export function checkImportFile(file: FileLike): FileCheck {
  if (!/\.csv$/i.test(file.name)) {
    return {
      ok: false,
      message:
        'Choose a .csv file. In Excel or Google Sheets use File → Save as / Download → CSV (UTF-8); .xlsx and .xls files are not accepted.',
    };
  }
  const type = file.type.trim().toLowerCase();
  if (type !== '' && !ACCEPTED_MIME_TYPES.has(type)) {
    return { ok: false, message: 'This file is not a CSV (comma separated) file.' };
  }
  if (file.size === 0) {
    return { ok: false, message: 'This file is empty. Start from the template.' };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      message: `This file is ${formatBytes(file.size)}. Imports are limited to ${formatBytes(MAX_IMPORT_BYTES)}; split it into smaller files.`,
    };
  }
  return { ok: true };
}

// --- content pre-flight (after reading the file) -----------------------------------

export type PreflightIssueCode =
  | 'empty'
  | 'malformed'
  | 'too_many_rows'
  | 'header_looks_like_data'
  | 'header_unknown'
  | 'header_duplicate'
  | 'header_missing'
  | 'no_data_rows';

export interface PreflightIssue {
  code: PreflightIssueCode;
  message: string;
}

export type PreflightResult =
  | { ok: true; rowCount: number; columns: ImportStudentColumn[] }
  | { ok: false; issue: PreflightIssue };

/** `Email Address` → `email_address`: the server matches headers after this normalization. */
export function normalizeHeader(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function fail(code: PreflightIssueCode, message: string): PreflightResult {
  return { ok: false, issue: { code, message } };
}

/** Header cells are echoed back to the person; keep them short and single-line. */
function displayName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 30);
}

const HEADER_HINT = `Expected a first row of column names, e.g. ${IMPORT_STUDENT_COLUMNS.join(',')}.`;

/**
 * Structural check of a CSV's text with the same rules the server applies to
 * the whole file (header columns, row cap, quoting). Problems inside a single
 * row are left to the server, which reports them row by row.
 */
export function preflightCsv(text: string): PreflightResult {
  let records: string[][];
  try {
    records = parseCsv(text, { maxRecords: MAX_IMPORT_ROWS + 1 });
  } catch (cause) {
    if (cause instanceof CsvParseError) {
      if (cause.failure === 'too_many_records') {
        return fail(
          'too_many_rows',
          `The file has more than ${formatInt(MAX_IMPORT_ROWS)} data rows. Split it into files of at most ${formatInt(MAX_IMPORT_ROWS)} rows.`,
        );
      }
      return fail(
        'malformed',
        'The file could not be read as CSV. Check for a quote (") that is never closed or that sits in the middle of a value.',
      );
    }
    throw cause;
  }

  const [headerCells, ...dataRecords] = records;
  if (!headerCells) return fail('empty', `The file has no rows. ${HEADER_HINT}`);

  // A file with no header row has a student's email in its first cell. Say so,
  // and never echo the cell.
  if (headerCells.some((cell) => cell.includes('@'))) {
    return fail('header_looks_like_data', `The first row looks like a student, not column names. ${HEADER_HINT}`);
  }

  const header = headerCells.map(normalizeHeader);
  const unknown = header.filter((name) => !KNOWN_COLUMNS.has(name));
  if (unknown.length > 0) {
    return fail(
      'header_unknown',
      `Unrecognized column${unknown.length === 1 ? '' : 's'}: ${unknown.slice(0, 5).map(displayName).join(', ')}. Allowed columns: ${IMPORT_STUDENT_COLUMNS.join(', ')}.`,
    );
  }
  if (new Set(header).size !== header.length) {
    return fail('header_duplicate', 'The header row lists the same column more than once.');
  }
  const missing = REQUIRED_COLUMNS.filter((name) => !header.includes(name));
  if (missing.length > 0) {
    return fail('header_missing', `The header row is missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);
  }
  if (dataRecords.length === 0) {
    return fail('no_data_rows', 'The file has a header row but no students below it.');
  }

  return { ok: true, rowCount: dataRecords.length, columns: header as ImportStudentColumn[] };
}

/** Shown when the file's bytes are not valid UTF-8 (decoded strictly by the import page). */
export const NOT_UTF8_MESSAGE =
  'This file is not UTF-8 encoded, so accented characters would be corrupted. Save it again as “CSV UTF-8”.';

// --- row errors -----------------------------------------------------------------

const ROW_ERROR_TEXT = {
  MALFORMED_ROW: 'The row is not a valid record (for example, it has more values than the header has columns).',
  UNKNOWN_FIELD: 'The row has a value in a column Atlas does not recognize.',
  MISSING_EMAIL: 'The email is missing.',
  INVALID_EMAIL: 'The email is not a valid email address.',
  MISSING_FULL_NAME: 'The full name is missing.',
  INVALID_FULL_NAME: 'The full name is too long (200 characters at most) or contains control characters.',
  INVALID_STUDENT_ID: 'The student ID is too long (64 characters at most) or contains control characters.',
  INVALID_GRADUATION_YEAR: 'The graduation year must be a four-digit year between 1950 and 2100.',
  INVALID_PROGRAM: 'The program is too long (200 characters at most) or contains control characters.',
} as const satisfies Record<ImportRowErrorReason, string>;

export function describeRowError(reason: string): string {
  return (ROW_ERROR_TEXT as Record<string, string>)[reason] ?? 'The row could not be used.';
}

export interface RowErrorGroup {
  reason: ImportRowErrorReason;
  count: number;
  description: string;
}

/** One line per reason, most frequent first (ties in the API's vocabulary order), so 3,000 errors read as five lines. */
export function groupRowErrors(errors: readonly { row: number; reason: ImportRowErrorReason }[]): RowErrorGroup[] {
  const counts = new Map<ImportRowErrorReason, number>();
  for (const error of errors) counts.set(error.reason, (counts.get(error.reason) ?? 0) + 1);
  return IMPORT_ROW_ERROR_REASONS.filter((reason) => counts.has(reason))
    .map((reason) => ({ reason, count: counts.get(reason) ?? 0, description: describeRowError(reason) }))
    .sort((a, b) => b.count - a.count);
}

// --- result summary -----------------------------------------------------------------

export interface SummaryLine {
  key: string;
  label: string;
  count: number;
  explanation: string;
}

export interface ImportSummary {
  /** `imported`: at least one student was added or changed. */
  outcome: 'imported' | 'nothing_changed' | 'nothing_imported';
  headline: string;
  lines: SummaryLine[];
  notes: string[];
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * Turns the API's report into plain statements. Every count is the API's own;
 * the explanations only say what each bucket means (docs in
 * packages/types/src/admin.ts). The invariant
 * `created + updated + skipped + errors = total_rows` is not re-derived here.
 */
export function summarizeImport(result: ImportStudentsResponse, replayed: boolean): ImportSummary {
  const errorCount = result.errors.length;
  const { unchanged, duplicate_in_file: duplicates, no_platform_account: noAccount } = result.skipped_breakdown;

  const lines: SummaryLine[] = [
    { key: 'total', label: 'Rows read', count: result.total_rows, explanation: 'Data rows in the file, not counting the header.' },
    { key: 'created', label: 'Added to the roster', count: result.created, explanation: 'New roster entries.' },
    { key: 'updated', label: 'Updated', count: result.updated, explanation: 'Students already on the roster whose program or graduation year changed.' },
    {
      key: 'unchanged',
      label: 'Skipped: already up to date',
      count: unchanged,
      explanation: 'Already on the roster with the same values. Importing the same file twice ends up here.',
    },
    {
      key: 'duplicates',
      label: 'Skipped: repeated in the file',
      count: duplicates,
      explanation: 'The same email appeared in an earlier row. The first row was used.',
    },
    {
      key: 'no_account',
      label: 'Skipped: no Atlas account yet',
      count: noAccount,
      explanation:
        'No Atlas account has this email, so the student was not added. Nobody was emailed or invited. Import the file again after they have signed up.',
    },
    {
      key: 'errors',
      label: 'Rows with errors',
      count: errorCount,
      explanation: 'Not imported. The list below says what to fix.',
    },
  ];

  const notes: string[] = [];
  if (replayed) {
    notes.push('This is the saved result of an earlier import that used the same request. Nothing was applied a second time.');
  }
  if (result.ignored_fields.includes('full_name')) {
    notes.push('Names in the file were checked but not stored: a student’s name comes from their own Atlas account.');
  }
  if (result.ignored_fields.includes('student_id')) {
    notes.push('Student IDs in the file were checked but not stored: the roster has nowhere to keep an institution ID yet.');
  }

  const changed = result.created + result.updated;
  let outcome: ImportSummary['outcome'];
  let headline: string;
  if (changed > 0) {
    outcome = 'imported';
    const parts: string[] = [];
    if (result.created > 0) parts.push(`${formatInt(result.created)} added`);
    if (result.updated > 0) parts.push(`${formatInt(result.updated)} updated`);
    headline = `Import finished: ${parts.join(', ')}.`;
  } else if (errorCount === result.total_rows && result.total_rows > 0) {
    outcome = 'nothing_imported';
    headline = `No rows were imported: all ${formatInt(result.total_rows)} ${plural(result.total_rows, 'row has', 'rows have')} errors.`;
  } else if (noAccount > 0 && unchanged === 0 && duplicates === 0 && errorCount === 0) {
    outcome = 'nothing_imported';
    headline = 'No students were added: none of the emails has an Atlas account yet.';
  } else {
    outcome = 'nothing_changed';
    headline = 'Import finished: nothing needed to change.';
  }

  return { outcome, headline, lines, notes };
}
