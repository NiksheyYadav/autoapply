import { describe, expect, it } from 'vitest';
import { analyzeResumeForJob, containsKeyword, extractSkillKeywords, parseResumeText, scoreResume } from '../src/index.js';

/**
 * Resume and job text is typed by strangers (extracted text is capped at 200,000 characters). The
 * regular-expression based parts must stay roughly linear on it, or one upload or one posting ties up
 * a serverless function until the platform kills it.
 *
 * Each shape below is aimed at a usual backtracking trap: a long run of one character, a near miss of a
 * pattern, thousands of repeats of a section header, bullet or date. Running them at the full 200,000
 * characters would hang the test run if a pattern regressed (nothing can interrupt a regular expression
 * from inside the process), so each shape is run at two small sizes and the growth is checked: four
 * times the text may cost about four times as long, and a quadratic pattern costs sixteen times.
 */
const SMALL = 10_000;
const LARGE = 40_000;
const GROWTH_LIMIT = 9;
/** Below this a run is too short to measure the growth of, and plainly fast enough. */
const NEGLIGIBLE_MS = 60;

type Shape = (size: number) => string;
const fill =
  (unit: string): Shape =>
  (size) =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const SHAPES: ReadonlyArray<readonly [string, Shape]> = [
  ['one letter', fill('a')],
  ['spaces', fill(' ')],
  ['newlines', fill('\n')],
  ['tabs and spaces', fill(' \t')],
  ['hyphens', fill('-')],
  ['bullets', fill('• ')],
  ['dash bullets, one per line', fill('- a\n')],
  ['digits', fill('1')],
  ['near-miss email: repeated local@', fill('a@')],
  ['near-miss email: dots', fill('a.')],
  ['near-miss url', fill('http://')],
  ['parentheses', fill('(')],
  ['phone-like digits', fill('(555) 555-')],
  ['date ranges', fill('Jan 2020 - ')],
  ['years', fill('2020-')],
  ['section header repeated', fill('Experience\n')],
  ['skills header repeated', fill('SKILLS: ')],
  ['education header repeated', fill('Education\nBSc ')],
  ['c++ and .net', fill('c++ .net c# ')],
  ['regex metacharacters', fill('.*+?^${}()|[]\\')],
  ['combining marks', fill('é')],
  ['emoji', fill('🙂')],
  ['right-to-left text', fill('שלום ')],
  ['NUL bytes', fill('\u0000')],
  ['one long word ending in a symbol', (size) => `${fill('word')(size)}!`],
  ['job-title lines', fill('Senior Engineer at Acme Corp, Berlin (2019 - 2021)\n')],
  ['percent and digit bullets', fill('* Improved 20% \n')],
  ['one word, then spaces, then another', (size) => `a${' '.repeat(size)}b`],
  ['month, then spaces', (size) => `Jan${' '.repeat(size)}x`],
  ['year, then spaces', (size) => `2020${' '.repeat(size)}x`],
  ['range separators', fill('2020 - ')],
  ['"to" ranges', fill('Jan 2020 to ')],
  ['at-sign, then a long domain', (size) => `a@${'b'.repeat(size)}`],
  ['at-sign, then dotted labels', (size) => `a@${fill('b.')(size)}`],
  ['degree line', (size) => `bachelor ${fill('in a')(size)}`],
  ['one huge line with a separator at the end', (size) => `${'a'.repeat(size)} at ${'b'.repeat(10)}`],
  ['many separators', fill('a - ')],
];

/** The fastest of three runs, in milliseconds (the minimum is the least affected by other work). */
function bestOfThree(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

function expectLinear(label: string, run: (size: number) => unknown): void {
  const small = bestOfThree(() => run(SMALL));
  const large = bestOfThree(() => run(LARGE));
  if (large <= NEGLIGIBLE_MS) return;
  expect(large / Math.max(small, 1), `${label}: ${small.toFixed(1)} ms at ${SMALL}, ${large.toFixed(1)} ms at ${LARGE}`).toBeLessThan(
    GROWTH_LIMIT,
  );
}

describe('text processing grows linearly on hostile input', () => {
  it.each(SHAPES)('parseResumeText + scoreResume: %s', (label, shape) => {
    expectLinear(label, (size) => {
      const text = shape(size);
      return scoreResume(parseResumeText(text), text);
    });
  });

  it.each(SHAPES)('extractSkillKeywords: %s', (label, shape) => {
    expectLinear(label, (size) => extractSkillKeywords(shape(size)));
  });

  it.each(SHAPES)('analyzeResumeForJob with this as both the resume and the posting: %s', (label, shape) => {
    expectLinear(label, (size) => {
      const text = shape(size);
      return analyzeResumeForJob(parseResumeText(text), text, {
        title: text.slice(0, 300),
        description: text,
        skills: [],
      });
    });
  });

  it('containsKeyword treats a keyword as text, not as a pattern', () => {
    expect(containsKeyword('uses c++ daily', 'c++')).toBe(true);
    expect(containsKeyword('aaaaaaaaaaaaaaaaaaaaaaaaaaaa', '(a+)+$')).toBe(false);
    expect(containsKeyword('x'.repeat(100_000), '(x+x+)+y')).toBe(false);
  });
});

describe('the email pattern still reads ordinary addresses', () => {
  it.each([
    ['Ada Lovelace\nada.lovelace+jobs@example.co.uk\n', 'ada.lovelace+jobs@example.co.uk'],
    ['contact: a_b-c%d@sub.domain-name.org, phone', 'a_b-c%d@sub.domain-name.org'],
    ['x@y.io', 'x@y.io'],
  ])('finds the address in %j', (text, email) => {
    expect(parseResumeText(text).contact.email).toBe(email);
  });

  it('finds no address in text that has none', () => {
    expect(parseResumeText('no address here, only a@b').contact.email).toBeNull();
    expect(parseResumeText(`${'a'.repeat(5000)}`).contact.email).toBeNull();
  });
});
