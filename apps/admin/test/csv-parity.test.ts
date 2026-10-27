import { describe, expect, it } from 'vitest';
import { CsvParseError as ServerCsvParseError, parseCsv as serverParseCsv } from '../../../services/admin/src/lib/csv-parse';
import { CsvParseError, parseCsv } from '../src/lib/csv';

/**
 * The console pre-checks a roster file with its own copy of the CSV reader so
 * it can say "too many rows" before uploading. If the server's reader changes
 * and this copy does not, the pre-check would pass files the server rejects
 * (or the reverse). services/admin/src/lib/csv-parse.ts has no dependencies,
 * so this test runs both readers over the same inputs and demands identical
 * answers.
 */

type Outcome = { records: string[][] } | { failure: string; record: number };

function run(
  parse: (input: string, options: { maxRecords: number }) => string[][],
  isParseError: (error: unknown) => error is { failure: string; record: number },
  input: string,
  maxRecords: number,
): Outcome {
  try {
    return { records: parse(input, { maxRecords }) };
  } catch (error) {
    if (isParseError(error)) return { failure: error.failure, record: error.record };
    throw error;
  }
}

const isClientError = (error: unknown): error is CsvParseError => error instanceof CsvParseError;
const isServerError = (error: unknown): error is ServerCsvParseError => error instanceof ServerCsvParseError;

function compare(input: string, maxRecords = 50): void {
  expect(run(parseCsv, isClientError, input, maxRecords), JSON.stringify(input)).toEqual(
    run(serverParseCsv, isServerError, input, maxRecords),
  );
}

const CORPUS = [
  '',
  '\n',
  '\r\n\r\n',
  ',,,,\n',
  'a',
  'a,b',
  'a,b\n',
  'a,b\r\nc,d\r\n',
  'a,b\rc,d\r',
  'a,b\n\nc,d',
  'a,b,',
  'a,b,\n,\n',
  '﻿email,full_name\na@x.edu,A',
  '"a,b",c\n',
  '"line1\nline2",c\n',
  '"he said ""hi""",c\n',
  '""\n',
  '"",\n',
  '"unterminated\n',
  '"a"b,c\n',
  'a,"b"c\n',
  'a"b,c\n',
  'a,b\n"x"\n"y\n',
  'a\n'.repeat(60),
  'a,b\n'.repeat(51),
  ' , \n a , b \n',
  '"  ",\n',
];

describe('client CSV reader matches the server reader', () => {
  it.each(CORPUS.map((input) => [JSON.stringify(input), input] as const))('on %s', (_label, input) => {
    compare(input);
  });

  it('agrees at the record cap, one below and one above', () => {
    for (const records of [4, 5, 6]) {
      compare('x\n'.repeat(records), 5);
    }
  });

  it('agrees on 500 pseudo-random inputs over the characters that matter', () => {
    // Deterministic LCG: the same inputs every run.
    let seed = 20261117;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const alphabet = ['a', 'b', ' ', ',', ',', '"', '"', '\n', '\r', '\r\n', 'é', '﻿'];
    for (let i = 0; i < 500; i += 1) {
      const length = Math.floor(next() * 24);
      let input = '';
      for (let j = 0; j < length; j += 1) input += alphabet[Math.floor(next() * alphabet.length)];
      compare(input, 6);
    }
  });
});
