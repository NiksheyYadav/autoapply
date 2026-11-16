import { describe, expect, it } from 'vitest';
import { CsvParseError, parseCsv } from '../src/lib/csv-parse.js';
import { UTF8_BOM, csvCell, neutralizeFormula, toCsv } from '../src/lib/csv-write.js';

const parse = (text: string, maxRecords = 100) => parseCsv(text, { maxRecords });

describe('parseCsv', () => {
  it('reads plain records with LF, CRLF and CR separators', () => {
    expect(parse('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parse('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parse('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles quotes, escaped quotes, commas and newlines inside quoted fields', () => {
    expect(parse('name,note\n"Doe, Jane","said ""hi""\nthen left"\n')).toEqual([
      ['name', 'note'],
      ['Doe, Jane', 'said "hi"\nthen left'],
    ]);
    expect(parse('"a"""\n')).toEqual([['a"']]);
  });

  it('strips a UTF-8 byte-order mark', () => {
    expect(parse('﻿email,full_name\nx@y.test,X')).toEqual([
      ['email', 'full_name'],
      ['x@y.test', 'X'],
    ]);
  });

  it('keeps empty cells, including a trailing delimiter at end of line and end of file', () => {
    expect(parse('a,b,c\n1,,3\n4,5,\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
      ['4', '5', ''],
    ]);
    expect(parse('a,b\n1,')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });

  it('drops blank lines and rows made only of empty cells (Excel pads exports with ",,,")', () => {
    expect(parse('a,b\n\n,\n  ,  \n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('reads input with no trailing newline and an empty input', () => {
    expect(parse('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parse('')).toEqual([]);
  });

  it('treats a quote inside an unquoted field as a literal character', () => {
    expect(parse('5" pipe,x\n')).toEqual([['5" pipe', 'x']]);
  });

  it('fails on an unterminated quote and on text after a closing quote', () => {
    expect(() => parse('a,"b\n')).toThrow(CsvParseError);
    expect(() => parse('"a"b,c\n')).toThrow(
      expect.objectContaining({ failure: 'misplaced_quote' }),
    );
    expect(() => parse('a,"b')).toThrow(expect.objectContaining({ failure: 'unterminated_quote' }));
  });

  it('stops as soon as the record limit is exceeded', () => {
    expect(parse('a\n1\n2\n', 3)).toHaveLength(3);
    expect(() => parse('a\n1\n2\n3\n', 3)).toThrow(
      expect.objectContaining({ failure: 'too_many_records' }),
    );
  });

  it('parses a large file in linear time', () => {
    const body = Array.from(
      { length: 20_000 },
      (_, i) => `u${i}@example.test,"Name ${i}",2026`,
    ).join('\n');
    const started = performance.now();
    const records = parse(`email,full_name,graduation_year\n${body}`, 30_000);
    expect(records).toHaveLength(20_001);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('csv formula neutralization', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd', '=HYPERLINK("http://evil.test","x")'])(
    'prefixes a single quote to a cell starting with a formula trigger: %j',
    (value) => {
      expect(neutralizeFormula(value)).toBe(`'${value}`);
      expect(csvCell(value).replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it.each(['', 'plain', 'a=b', 'x+y', ' =lead-space', "'quoted", '0', 'é=1'])(
    'leaves a safe cell alone: %j',
    (value) => {
      expect(neutralizeFormula(value)).toBe(value);
    },
  );

  it('does not touch numbers and booleans, which the service itself produces', () => {
    expect(csvCell(0)).toBe('0');
    expect(csvCell(71.5)).toBe('71.5');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(false)).toBe('false');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('quotes cells containing delimiters, quotes or line breaks and doubles inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
    expect(csvCell(' padded ')).toBe('" padded "');
  });

  it('neutralizes before quoting, so an injected cell stays inert after escaping', () => {
    expect(csvCell('=cmd|"/c calc"!A1')).toBe(`"'=cmd|""/c calc""!A1"`);
    expect(csvCell('\t=1,2')).toBe(`"'\t=1,2"`);
  });

  it('round-trips awkward text through toCsv and parseCsv', () => {
    const values = ['Doe, Jane', 'say "hi"', 'two\nlines', "O'Brien", 'plain', '', 'ünï©ode ✓'];
    const csv = toCsv(
      ['value'],
      values.map((value) => [value]),
    );
    const parsed = parseCsv(csv, { maxRecords: 100 });
    // The blank value is a blank line and is dropped by the reader.
    expect(parsed.slice(1).map((row) => row[0])).toEqual(values.filter((value) => value !== ''));
  });

  it('writes CRLF-terminated lines and an optional BOM', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
    expect(toCsv(['a'], [], { bom: true })).toBe(`${UTF8_BOM}a\r\n`);
  });
});
