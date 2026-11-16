/**
 * Minimal HTML to plain text for job descriptions. Not a sanitizer and not an
 * HTML parser: the output is stored as plain text and never rendered as markup,
 * so the only goals are readable text for skill extraction and for people, and
 * linear running time on a few hundred kilobytes of untrusted input (a
 * `<[^>]*>` style regular expression is quadratic on a long run of `<`).
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bull: '\u2022',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  eacute: '\u00e9',
  euro: '\u20ac',
};

const ENTITY_RE = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,15});/gi;

function codePointToString(codePoint: number): string | null {
  const valid =
    Number.isInteger(codePoint) &&
    codePoint > 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff);
  return valid ? String.fromCodePoint(codePoint) : null;
}

/**
 * Decodes HTML character references exactly once. Unknown named references and
 * out-of-range numeric ones are left as written, so decoding never invents text.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointToString(Number.parseInt(body.slice(2), 16)) ?? match;
    }
    if (body.startsWith('#')) {
      return codePointToString(Number.parseInt(body.slice(1), 10)) ?? match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Closing tags that end a visual block: a paragraph break in the plain text. */
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'tr', 'section', 'article', 'blockquote']);
const RAW_TEXT_TAGS = new Set(['script', 'style']);

const isLetter = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isTagNameChar = (code: number): boolean => isLetter(code) || (code >= 48 && code <= 57);

/**
 * Replaces markup with the text layout it implies: `<br>` a line break, the end
 * of a block a blank line, `<li>` a "- " bullet; everything else disappears and
 * `<script>`/`<style>` contents are dropped. A `<` that does not start a tag
 * ("a < b") is ordinary text. One pass over the input: every position is
 * visited a bounded number of times, whatever the input looks like.
 */
export function stripTags(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let cursor = 0;
  // Once no ">" remains after some point, no later "<" can close into a tag either.
  let noMoreClosers = false;
  // Same for raw-text elements whose end tag is missing.
  const noMoreEndTag = new Set<string>();

  while (cursor < html.length) {
    const open = html.indexOf('<', cursor);
    if (open === -1) break;
    out += html.slice(cursor, open);

    const next = html.charCodeAt(open + 1);
    const slash = next === 47; // "/"
    const nameStart = open + (slash ? 2 : 1);
    const looksLikeTag = slash || isLetter(next) || next === 33 /* ! */ || next === 63 /* ? */;
    const close = looksLikeTag && !noMoreClosers ? html.indexOf('>', open + 1) : -1;
    if (close === -1) {
      if (looksLikeTag) noMoreClosers = true;
      // Not a tag: keep the "<" as text and carry on after it.
      out += '<';
      cursor = open + 1;
      continue;
    }

    let nameEnd = nameStart;
    while (nameEnd < close && isTagNameChar(html.charCodeAt(nameEnd))) nameEnd += 1;
    const name = lower.slice(nameStart, nameEnd);

    cursor = close + 1;
    if (slash) {
      if (BLOCK_TAGS.has(name)) out += '\n\n';
    } else if (name === 'br') {
      out += '\n';
    } else if (name === 'li') {
      out += '\n- ';
    } else if (RAW_TEXT_TAGS.has(name) && html.charCodeAt(close - 1) !== 47 && !noMoreEndTag.has(name)) {
      const end = lower.indexOf(`</${name}`, cursor);
      if (end === -1) {
        noMoreEndTag.add(name);
      } else {
        const endClose = html.indexOf('>', end);
        cursor = endClose === -1 ? html.length : endClose + 1;
        out += ' ';
      }
    }
  }
  return out + html.slice(cursor);
}

export function htmlToText(html: string): string {
  return tidyWhitespace(decodeHtmlEntities(stripTags(html)));
}

/** Trims lines, collapses runs of spaces, and keeps at most one blank line in a row. */
export function tidyWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\u00a0\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
