import { describe, expect, it } from 'vitest';
import { filenameFromContentDisposition } from '../src/lib/content-disposition';
import { formatBytes, formatDate } from '../src/lib/format';

const FALLBACK = 'students.csv';

describe('filenameFromContentDisposition', () => {
  it('reads the quoted file name the export endpoint sends', () => {
    expect(filenameFromContentDisposition('attachment; filename="students-2026-10-27.csv"', FALLBACK)).toBe(
      'students-2026-10-27.csv',
    );
  });

  it('reads an unquoted file name', () => {
    expect(filenameFromContentDisposition('attachment; filename=roster.csv', FALLBACK)).toBe('roster.csv');
  });

  it.each([
    [null],
    [''],
    ['attachment'],
    ['attachment; filename=""'],
    ['attachment; filename="../../etc/passwd.csv"'],
    ['attachment; filename="a b.csv"'],
    ['attachment; filename="students.exe"'],
    ['attachment; filename="students.csv.html"'],
    ['attachment; filename=".csv"'],
    ['attachment; filename="C:\\x\\students.csv"'],
    [`attachment; filename="${'a'.repeat(200)}.csv"`],
  ])('falls back for %j', (header) => {
    expect(filenameFromContentDisposition(header, FALLBACK)).toBe(FALLBACK);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1536, '1.5 KB'],
    [20 * 1024, '20 KB'],
    [4 * 1024 * 1024, '4.0 MB'],
    [Number.NaN, '—'],
    [-1, '—'],
  ])('%d bytes is %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('formatDate', () => {
  it('shows an em dash for missing or unparseable input instead of "Invalid Date"', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });

  it('formats a real timestamp', () => {
    expect(formatDate('2026-10-27T12:00:00.000Z')).toMatch(/2026/);
  });
});
