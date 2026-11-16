/**
 * CSV output with spreadsheet formula-injection neutralization.
 *
 * A cell that starts with `=`, `+`, `-`, `@`, TAB or CR is interpreted as a
 * formula by Excel, LibreOffice and Google Sheets, which turns any text a user
 * controls (a program name, a platform display name) into code that runs on
 * the staff member's machine when they open an export. OWASP's mitigation is
 * applied to every *string* cell: prefix a single quote so the cell is plain
 * text. Numbers and booleans are generated here, never user-supplied, and are
 * emitted as-is.
 */

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

export function neutralizeFormula(value: string): string {
  const first = value.charAt(0);
  return FORMULA_TRIGGERS.has(first) ? `'${value}` : value;
}

function needsQuoting(text: string): boolean {
  return /[",\r\n]/.test(text) || text.startsWith(' ') || text.endsWith(' ');
}

/** Encodes one cell: neutralize (strings only), then quote and escape per RFC 4180. */
export function csvCell(value: CsvCell): string {
  let text: string;
  if (value === null || value === undefined) {
    return '';
  } else if (typeof value === 'number') {
    text = Number.isFinite(value) ? String(value) : '';
  } else if (typeof value === 'boolean') {
    text = value ? 'true' : 'false';
  } else {
    text = neutralizeFormula(value);
  }
  return needsQuoting(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const UTF8_BOM = '﻿';

export interface ToCsvOptions {
  /** Prefix a UTF-8 byte-order mark so Excel detects the encoding. */
  bom?: boolean;
}

/** Header plus rows, CRLF-terminated (RFC 4180). */
export function toCsv(
  header: readonly string[],
  rows: Iterable<readonly CsvCell[]>,
  options: ToCsvOptions = {},
): string {
  const lines: string[] = [header.map((name) => csvCell(name)).join(',')];
  for (const row of rows) lines.push(row.map((cell) => csvCell(cell)).join(','));
  return `${options.bom === true ? UTF8_BOM : ''}${lines.join('\r\n')}\r\n`;
}
