import { describe, expect, it } from 'vitest';
import { preflightCsv } from '../src/lib/import-csv';

/**
 * The console reads the chosen file in the browser before uploading it. Reading must stay linear in
 * its size (a quadratic pattern would freeze the tab on a 4 MB file) and must always answer. Each shape runs at two sizes and the growth is
 * checked rather than running the full size, so a regression fails fast instead of hanging.
 */
const SMALL = 100_000;
const LARGE = 400_000;
const HEADER = 'email,full_name\n';
const fill = (unit: string) => (size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const SHAPES: ReadonlyArray<readonly [string, (size: number) => string]> = [
  ['only commas', (size) => HEADER + fill(',')(size)],
  ['only newlines', (size) => HEADER + fill('\n')(size)],
  ['only carriage returns', (size) => HEADER + fill('\r')(size)],
  ['CRLF blank lines', (size) => HEADER + fill('\r\n')(size)],
  ['an open quote that never closes', (size) => `${HEADER}"${'a'.repeat(size)}`],
  ['quotes inside an unquoted field', (size) => HEADER + fill('a"b,')(size)],
  ['doubled quotes inside a quoted field', (size) => `${HEADER}"${fill('""')(size)}"`],
  ['alternating quotes and commas', (size) => HEADER + fill('","')(size)],
  ['one enormous cell', (size) => `${HEADER}a@b.co,${'x'.repeat(size)}`],
  ['many tiny rows', (size) => HEADER + fill('a@b.co,N\n')(size)],
  ['many columns in one row', (size) => `${HEADER}${fill('a,')(size)}`],
  ['spaces and tabs', (size) => HEADER + fill(' \t')(size)],
  ['a BOM repeated', (size) => HEADER + fill('﻿')(size)],
  ['NUL bytes', (size) => `${HEADER}a@b.co,${fill('\u0000')(size)}`],
  ['formula prefixes', (size) => HEADER + fill('=cmd|\' /C calc\'!A0,+1\n')(size)],
];

function runtime(text: string): number {
  const start = performance.now();
  // A file the console refuses is fine; what matters is that it answers, and quickly.
  const result = preflightCsv(text);
  expect(typeof result.ok).toBe('boolean');
  return performance.now() - start;
}

describe('the browser-side roster CSV check on hostile input', () => {
  it.each(SHAPES)('stays linear: %s', (_label, shape) => {
    const small = Math.min(runtime(shape(SMALL)), runtime(shape(SMALL)));
    const large = Math.min(runtime(shape(LARGE)), runtime(shape(LARGE)));
    if (large <= 80) return;
    expect(large / Math.max(small, 1), `${small.toFixed(1)} ms at ${SMALL}, ${large.toFixed(1)} ms at ${LARGE}`).toBeLessThan(9);
  });
});
