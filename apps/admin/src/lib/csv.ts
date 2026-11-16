/**
 * Pre-flight CSV reader for the roster import. It mirrors the reader in
 * services/admin (src/lib/csv-parse.ts, RFC 4180: quoted fields, `""` escapes,
 * quoted newlines, CRLF / LF / CR, optional BOM, blank records dropped) so the
 * console can report "too many rows" or "broken quoting" before the file is
 * uploaded. The server stays the authority: it re-parses everything. A test
 * (test/csv-parity.test.ts) runs both readers on the same inputs so they
 * cannot drift apart unnoticed.
 */

export type CsvFailure = 'unterminated_quote' | 'misplaced_quote' | 'too_many_records';

export class CsvParseError extends Error {
  constructor(
    readonly failure: CsvFailure,
    /** 1-based index of the record being read when parsing stopped. */
    readonly record: number,
  ) {
    super(`CSV parse failed: ${failure}`);
    this.name = 'CsvParseError';
  }
}

export interface ParseCsvOptions {
  /** Maximum number of non-blank records (header included) before failing fast. */
  maxRecords: number;
}

function isBlankRecord(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim() === '');
}

/** Returns the non-blank records of `input`. */
export function parseCsv(input: string, options: ParseCsvOptions): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const length = text.length;
  const records: string[][] = [];
  let row: string[] = [];
  let index = 0;

  const finishRecord = (): void => {
    if (!isBlankRecord(row)) {
      records.push(row);
      if (records.length > options.maxRecords) {
        throw new CsvParseError('too_many_records', records.length);
      }
    }
    row = [];
  };

  while (index < length) {
    let field: string;

    if (text[index] === '"') {
      index += 1;
      field = '';
      for (;;) {
        const quote = text.indexOf('"', index);
        if (quote === -1) throw new CsvParseError('unterminated_quote', records.length + 1);
        field += text.slice(index, quote);
        if (text[quote + 1] === '"') {
          field += '"';
          index = quote + 2;
          continue;
        }
        index = quote + 1;
        break;
      }
      const next = text[index];
      if (index < length && next !== ',' && next !== '\n' && next !== '\r') {
        throw new CsvParseError('misplaced_quote', records.length + 1);
      }
    } else {
      const start = index;
      while (index < length) {
        const char = text[index];
        if (char === ',' || char === '\n' || char === '\r') break;
        index += 1;
      }
      field = text.slice(start, index);
    }

    row.push(field);

    if (index >= length) {
      finishRecord();
      break;
    }

    if (text[index] === ',') {
      index += 1;
      if (index >= length) {
        // A trailing delimiter at EOF still ends with an (empty) field.
        row.push('');
        finishRecord();
        break;
      }
      continue;
    }

    index += text[index] === '\r' && text[index + 1] === '\n' ? 2 : 1;
    finishRecord();
  }

  return records;
}
