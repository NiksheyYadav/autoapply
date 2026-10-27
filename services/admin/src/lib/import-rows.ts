import {
  ADMIN_MAX_IMPORT_ROWS,
  IMPORT_STUDENT_COLUMNS,
  hasControlCharacters,
  importStudentRowSchema,
  type ImportRowErrorReason,
  type ImportStudentColumn,
} from '@atlas/types';
import { AppError } from '@atlas/utils';
import { CsvParseError, parseCsv } from './csv-parse.js';

/** One submitted row exactly as received: CSV rows arrive as strings, JSON rows as anything. */
export type RawImportRow = Record<string, unknown> | null;

/** A row that passed validation, with the fields the roster actually stores. */
export interface ValidImportRow {
  /** 1-based position among data rows. */
  row: number;
  /** Trimmed and lower-cased: the dedupe and account-lookup key. */
  email: string;
  program: string | undefined;
  graduationYear: number | undefined;
  /** The row carried a student id, which is validated but not stored (no column for it). */
  suppliedStudentId: boolean;
}

export type RowOutcome =
  | { row: number; ok: true; value: ValidImportRow }
  | { row: number; ok: false; reason: ImportRowErrorReason };

const REQUIRED_COLUMNS: readonly ImportStudentColumn[] = ['email', 'full_name'];
const KNOWN_COLUMNS: ReadonlySet<string> = new Set(IMPORT_STUDENT_COLUMNS);

/** `Email Address` → `email_address`; lets a hand-edited header still match. */
function normalizeHeader(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** Header names echo back to the caller in an error, so bound and defang them first. */
function safeHeaderName(name: string): string {
  const cleaned = Array.from(name.slice(0, 40))
    .map((char) => (hasControlCharacters(char) ? ' ' : char))
    .join('');
  return cleaned.trim();
}

function csvError(message: string, details?: unknown): AppError {
  return new AppError('VALIDATION_ERROR', message, details === undefined ? {} : { details });
}

/**
 * Turns a CSV body into raw rows keyed by canonical column name. Structural
 * problems (no header, unknown or duplicate columns, broken quoting) reject the
 * whole file; a problem inside one row is left for {@link validateImportRows}.
 */
export function csvToRawRows(
  text: string,
  maxRows: number = ADMIN_MAX_IMPORT_ROWS,
): RawImportRow[] {
  let records: string[][];
  try {
    records = parseCsv(text, { maxRecords: maxRows + 1 });
  } catch (cause) {
    if (cause instanceof CsvParseError) {
      if (cause.failure === 'too_many_records') {
        throw new AppError('PAYLOAD_TOO_LARGE', `An import may contain at most ${maxRows} rows`, {
          details: { max_rows: maxRows },
        });
      }
      throw csvError('CSV is malformed: check quoting', { record: cause.record });
    }
    throw cause;
  }

  const [headerCells, ...dataRecords] = records;
  if (!headerCells) throw csvError('CSV is empty: expected a header row');

  const header = headerCells.map(normalizeHeader);
  const unknown = header.filter((name) => !KNOWN_COLUMNS.has(name));
  if (unknown.length > 0) {
    throw csvError('CSV header has unknown columns', {
      unknown_columns: unknown.slice(0, 10).map(safeHeaderName),
      allowed_columns: IMPORT_STUDENT_COLUMNS,
    });
  }
  if (new Set(header).size !== header.length) throw csvError('CSV header has duplicate columns');
  const missing = REQUIRED_COLUMNS.filter((name) => !header.includes(name));
  if (missing.length > 0)
    throw csvError('CSV header is missing required columns', { missing_columns: missing });
  if (dataRecords.length === 0) throw csvError('CSV has no data rows');

  return dataRecords.map((cells): RawImportRow => {
    // Extra *empty* cells are harmless trailing delimiters; extra content is not.
    if (
      cells.length > header.length &&
      cells.slice(header.length).some((cell) => cell.trim() !== '')
    ) {
      return null;
    }
    const row: Record<string, unknown> = {};
    header.forEach((name, position) => {
      row[name] = cells[position] ?? '';
    });
    return row;
  });
}

/**
 * Extracts the rows from a JSON body: `{ "rows": [...] }`, or a bare array.
 * Per-row problems are left for {@link validateImportRows}.
 */
export function jsonToRawRows(
  body: unknown,
  maxRows: number = ADMIN_MAX_IMPORT_ROWS,
): RawImportRow[] {
  let rows: unknown;
  if (Array.isArray(body)) {
    rows = body;
  } else if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'rows') {
      throw csvError('Expected a JSON object with a single "rows" array');
    }
    rows = (body as { rows: unknown }).rows;
  }
  if (!Array.isArray(rows)) throw csvError('Expected "rows" to be an array');
  if (rows.length === 0) throw csvError('At least one row is required');
  if (rows.length > maxRows) {
    throw new AppError('PAYLOAD_TOO_LARGE', `An import may contain at most ${maxRows} rows`, {
      details: { max_rows: maxRows },
    });
  }
  return rows.map((row): RawImportRow =>
    typeof row === 'object' && row !== null && !Array.isArray(row)
      ? (row as Record<string, unknown>)
      : null,
  );
}

const REASON_BY_FIELD: Record<
  string,
  { missing?: ImportRowErrorReason; invalid: ImportRowErrorReason }
> = {
  email: { missing: 'MISSING_EMAIL', invalid: 'INVALID_EMAIL' },
  full_name: { missing: 'MISSING_FULL_NAME', invalid: 'INVALID_FULL_NAME' },
  student_id: { invalid: 'INVALID_STUDENT_ID' },
  graduation_year: { invalid: 'INVALID_GRADUATION_YEAR' },
  program: { invalid: 'INVALID_PROGRAM' },
};

/**
 * Blank cells (CSV `""`, JSON `null` / `""`) mean "not provided". Keys outside
 * the schema are dropped here so a hostile key such as `__proto__` is never
 * copied onto an object; their presence is reported separately.
 */
function cleanRow(raw: Record<string, unknown>): {
  cleaned: Record<string, unknown>;
  hasUnknownKey: boolean;
} {
  const cleaned: Record<string, unknown> = {};
  let hasUnknownKey = false;
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_COLUMNS.has(key)) {
      hasUnknownKey = true;
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    cleaned[key] = value;
  }
  return { cleaned, hasUnknownKey };
}

/** Validates each row on its own so one bad row never fails the others. */
export function validateImportRows(rawRows: readonly RawImportRow[]): RowOutcome[] {
  return rawRows.map((raw, position): RowOutcome => {
    const row = position + 1;
    // The type says object-or-null; this is a boundary, so do not trust it.
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { row, ok: false, reason: 'MALFORMED_ROW' };
    }

    const { cleaned, hasUnknownKey } = cleanRow(raw);
    if (hasUnknownKey) return { row, ok: false, reason: 'UNKNOWN_FIELD' };

    const parsed = importStudentRowSchema.safeParse(cleaned);
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? '');
      const reasons = REASON_BY_FIELD[field];
      const reason =
        reasons === undefined
          ? 'MALFORMED_ROW'
          : cleaned[field] === undefined && reasons.missing !== undefined
            ? reasons.missing
            : reasons.invalid;
      return { row, ok: false, reason };
    }

    const data = parsed.data;
    return {
      row,
      ok: true,
      value: {
        row,
        email: data.email,
        program: data.program,
        graduationYear: data.graduation_year,
        suppliedStudentId: data.student_id !== undefined,
      },
    };
  });
}

export interface ImportPlan {
  /** Valid rows with duplicate emails removed (first occurrence wins), in file order. */
  rows: ValidImportRow[];
  errors: { row: number; reason: ImportRowErrorReason }[];
  duplicates: number;
  /** Columns supplied in at least one valid row that the roster has nowhere to store. */
  ignoredFields: ('full_name' | 'student_id')[];
}

/** Splits outcomes into rows to apply, row errors and duplicates (by normalized email). */
export function planImport(outcomes: readonly RowOutcome[]): ImportPlan {
  const rows: ValidImportRow[] = [];
  const errors: ImportPlan['errors'] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let anyValid = false;
  let anyStudentId = false;

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      errors.push({ row: outcome.row, reason: outcome.reason });
      continue;
    }
    anyValid = true;
    anyStudentId ||= outcome.value.suppliedStudentId;
    if (seen.has(outcome.value.email)) {
      duplicates += 1;
      continue;
    }
    seen.add(outcome.value.email);
    rows.push(outcome.value);
  }

  const ignoredFields: ImportPlan['ignoredFields'] = [];
  if (anyValid) ignoredFields.push('full_name');
  if (anyStudentId) ignoredFields.push('student_id');
  return { rows, errors, duplicates, ignoredFields };
}
