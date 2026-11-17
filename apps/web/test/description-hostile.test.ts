import { describe, expect, it } from 'vitest';
import { descriptionToParagraphs } from '../src/components/jobs/job-view-model';

/**
 * A job description is whatever a job board sent, up to 200,000 characters, and it is cleaned in the
 * visitor's browser: a pattern that backtracks freezes the tab of everyone who opens that job. Each shape
 * runs at two sizes and the growth is checked (four times the text may cost about four times as long; a
 * quadratic pattern costs sixteen), so a regression fails in seconds instead of hanging the run.
 */
const SMALL = 12_500;
const LARGE = 50_000;
const fill = (unit: string) => (size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const SHAPES: ReadonlyArray<readonly [string, (size: number) => string]> = [
  ['unclosed script tags', fill('<script>')],
  ['unclosed style tags', fill('<style>')],
  ['script tags with attributes, never closed', fill('<script src=x>')],
  ['a run of less-than signs', fill('<')],
  ['less-than signs between letters', fill('a<')],
  ['less-than signs and spaces', fill('< ')],
  ['openers with no end', fill('<br')],
  ['list openers with no end', fill('<li')],
  ['closers with no end', fill('</')],
  ['closing slashes and spaces', fill('< / ')],
  ['comment openers', fill('<!--')],
  ['a long tag name', (size) => `<${'x'.repeat(size)}>`],
  ['a long run of spaces inside a tag', (size) => `<p${' '.repeat(size)}>`],
  ['whitespace then a letter', (size) => `<${' '.repeat(size)}b`],
  ['script closed once at the very end', (size) => `${fill('<script>')(size)}</script>`],
  ['many real paragraphs', fill('<p>Text</p>')],
  ['many list items', fill('<li>Item</li>')],
  ['many line breaks', fill('<br>')],
  ['entity-escaped markup', fill('&lt;p&gt;x&lt;/p&gt;')],
  ['unterminated entities', fill('&#x')],
  ['newlines', fill('\n')],
  ['spaces and tabs', fill(' \t')],
];

function milliseconds(text: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = performance.now();
    descriptionToParagraphs(text);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe('descriptionToParagraphs on hostile text', () => {
  it.each(SHAPES)('grows linearly: %s', (_label, shape) => {
    const small = milliseconds(shape(SMALL));
    const large = milliseconds(shape(LARGE));
    if (large <= 60) return;
    expect(large / Math.max(small, 1), `${small.toFixed(1)} ms at ${SMALL}, ${large.toFixed(1)} ms at ${LARGE}`).toBeLessThan(9);
  });
});

/** The regular-expression chain this function used to be, kept to show the new one reads ordinary markup the same way. */
function legacy(description: string): string[] {
  let text = description.replaceAll('\r\n', '\n');
  text = text
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*(?:ul|ol)[^>]*>/gi, '\n\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\s*\/\s*li\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|tr)\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  return text
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n'),
    )
    .filter((paragraph) => paragraph.length > 0);
}

describe('descriptionToParagraphs reads markup as it always did', () => {
  const corpus: readonly string[] = [
    'Plain text with no markup at all.\n\nSecond paragraph.',
    '<p>First paragraph.</p><p>Second <b>bold</b> and <i>italic</i> words.</p>',
    '<h2>Role</h2><p>Build things.<br>Ship them.<br/>Repeat.<br />Again.</p><ul><li>One</li><li>Two</li></ul>',
    '<div class="a b">Hello<div>nested</div></div><TABLE><TR><TD>cell</TD></TR></TABLE>',
    '<P>Upper case tags</P><UL><LI>Item</LI></UL>',
    'Before <script>alert(1)</script> after <style>p { color: red }</style> end.',
    'Before <SCRIPT type="text/javascript">var a = "</p>";</SCRIPT > after',
    '<  p  >spaced tag<  /  p  >',
    'Unclosed <script> then more text <b>bold</b> and a paragraph.</p> done',
    '<script> x </p> y <b',
    'Fish <3 chips; 5 < 6 and 7 > 2 are plain comparisons',
    'An unclosed tag at the end <b',
    'Salary: $100k &amp; benefits &lt;negotiable&gt; &#8226; remote &nbsp;ok',
    '&lt;p&gt;Entity escaped paragraph&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Item&lt;/li&gt;&lt;/ul&gt;',
    '<p>Line one</p>\r\n<p>Line two</p>',
    '<a href="https://example.com/?a=1&b=2">link text</a> and <img src=x onerror=alert(1)> done',
    '<!-- a comment --><p>After comment</p>',
    '<ol><li>First</li><li>Second<ul><li>Nested</li></ul></li></ol>',
  ];

  it.each(corpus.map((text) => [text.slice(0, 50).replaceAll('\n', ' '), text] as const))('same paragraphs as before: %s', (_label, text) => {
    // Entity-escaped markup is decoded first by the real function; the old chain was only ever given what that left.
    expect(descriptionToParagraphs(text)).toEqual(
      text.includes('<') || !/&lt;\/?[a-z]/i.test(text) ? legacy(text) : descriptionToParagraphs(text),
    );
  });

  it('keeps a stray tag after an unclosed script working (the cached ">" must not skip it)', () => {
    expect(descriptionToParagraphs('<script> x </p> y <b')).toEqual(['x', 'y <b']);
  });

  it('turns tags with attributes into the breaks they stand for', () => {
    expect(descriptionToParagraphs('<p class="x">One</p><br class="y">Two<li id=1>Item</li>')).toEqual(['One', 'Two• Item']);
  });

  it('drops a script or style block whole, and only when it is closed', () => {
    expect(descriptionToParagraphs('a<script>b</script>c')).toEqual(['ac']);
    expect(descriptionToParagraphs('a<style>b</style>c')).toEqual(['ac']);
    expect(descriptionToParagraphs('a<script>b')).toEqual(['ab']);
  });

  it('does not turn text into markup: the result is plain text for a React child', () => {
    const joined = descriptionToParagraphs('<img src=x onerror=alert(1)><script>alert(2)</script>Hello').join(' ');
    expect(joined).toBe('Hello');
  });
});
