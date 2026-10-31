import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../src/lib/filename.js';

describe('sanitizeFilename', () => {
  it.each([
    ['resume.pdf', 'resume.pdf'],
    ['My Resume (final) v2.docx', 'My Resume (final) v2.docx'],
    ['résumé 日本語 🙂.txt', 'résumé 日本語 🙂.txt'],
    ['  spaced   out  .pdf  ', 'spaced out .pdf'],
    ['../../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32\\config.txt', 'config.txt'],
    ['C:\\Users\\ada\\resume.pdf', 'resume.pdf'],
    ['/var/tmp/resume.pdf', 'resume.pdf'],
    ['a\u0000b.txt', 'ab.txt'],
    ['bell\u0007esc\u001b[31m.txt', 'bellesc[31m.txt'],
    ['resume\u202egnp.txt', 'resumegnp.txt'],
    ['line\r\nbreak.txt', 'linebreak.txt'],
  ])('turns %j into %j', (raw, expected) => {
    expect(sanitizeFilename(raw)).toBe(expected);
  });

  it.each([[''], ['   '], ['.'], ['..'], ['...'], ['. . .'], ['/'], ['dir/'], ['\u0000'], [undefined], [null]])(
    'falls back to a plain name for %j',
    (raw) => {
      expect(sanitizeFilename(raw as string | undefined)).toBe('resume');
    },
  );

  it('cuts a very long name to fit, keeping a short extension', () => {
    const cut = sanitizeFilename(`${'x'.repeat(5000)}.pdf`);
    expect(cut.length).toBeLessThanOrEqual(255);
    expect(cut.endsWith('.pdf')).toBe(true);
    expect(sanitizeFilename('y'.repeat(5000)).length).toBe(255);
    expect(sanitizeFilename(`${'z'.repeat(300)}.${'e'.repeat(40)}`).length).toBeLessThanOrEqual(255);
  });

  it('never cuts a character in half', () => {
    const emoji = '🙂'.repeat(400);
    const cut = sanitizeFilename(`${emoji}.txt`);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(Buffer.from(cut, 'utf8').toString('utf8')).toBe(cut);
  });
});
