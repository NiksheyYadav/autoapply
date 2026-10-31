import type { EmploymentType, Job, RemoteType } from '@atlas/types';

const REMOTE_LABELS: Record<RemoteType, string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
  unknown: 'Work arrangement not stated',
};

const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  internship: 'Internship',
  unknown: 'Employment type not stated',
};

/** Falls back to the raw value so a type added on the backend still renders something. */
export function remoteTypeLabel(value: string): string {
  return (REMOTE_LABELS as Record<string, string>)[value] ?? value.replaceAll('_', ' ');
}

export function employmentTypeLabel(value: string): string {
  return (EMPLOYMENT_LABELS as Record<string, string>)[value] ?? value.replaceAll('_', ' ');
}

/**
 * The employer to show for a job: the name the jobs API sent, else the one on an
 * application's job summary (older responses), else nothing. Blank names count as absent.
 */
export function employerName(job: Pick<Job, 'company_name'>, fallback?: string | null): string | null {
  for (const candidate of [job.company_name, fallback]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** 0–1 score -> whole percent, clamped; null for anything that isn't a finite number. */
export function matchPercent(score: unknown): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return Math.round(Math.min(1, Math.max(0, score)) * 100);
}

function formatAmount(amount: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      // Not an ISO 4217 code the runtime knows: show the digits with the raw code.
      return `${currency} ${amount.toLocaleString('en-US')}`;
    }
  }
  return amount.toLocaleString('en-US');
}

/** "$120,000 – $150,000", "From $90,000", "Up to $90,000", or null when the posting states no salary. */
export function formatSalary(job: Pick<Job, 'salary_min' | 'salary_max' | 'salary_currency'>): string | null {
  const { salary_min: min, salary_max: max, salary_currency: currency } = job;
  if (min !== null && max !== null) {
    return min === max ? formatAmount(min, currency) : `${formatAmount(min, currency)} – ${formatAmount(max, currency)}`;
  }
  if (min !== null) return `From ${formatAmount(min, currency)}`;
  if (max !== null) return `Up to ${formatAmount(max, currency)}`;
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  hellip: '…',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Block-level tags whose closing tag ends a paragraph. */
const PARAGRAPH_CLOSERS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'tr']);

const WHITESPACE = /\s/;
const isSpaceAt = (text: string, index: number): boolean => WHITESPACE.test(text.charAt(index));
const isNameCharAt = (text: string, index: number, first: boolean): boolean => {
  const code = text.charCodeAt(index) | 0x20; // folds A-Z onto a-z
  return (code >= 0x61 && code <= 0x7a) || (!first && text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39);
};

interface TagInfo {
  closing: boolean;
  name: string;
  /** Nothing but whitespace follows the name before the final ">" (so `</script >` but not `</script x>`). */
  bare: boolean;
}

/** Reads `<` + `text[start, end)` + `>` as a tag, by index, without copying: whitespace, an optional "/", a name. */
function readTag(text: string, start: number, end: number): TagInfo {
  let k = start;
  while (k < end && isSpaceAt(text, k)) k += 1;
  const closing = text.charAt(k) === '/' && k < end;
  if (closing) {
    k += 1;
    while (k < end && isSpaceAt(text, k)) k += 1;
  }
  const nameStart = k;
  while (k < end && isNameCharAt(text, k, k === nameStart)) k += 1;
  const name = text.slice(nameStart, k).toLowerCase();
  while (k < end && isSpaceAt(text, k)) k += 1;
  return { closing, name, bare: k === end };
}

function tagToText({ closing, name }: TagInfo): string {
  if (closing) {
    if (name === 'li') return '\n';
    return PARAGRAPH_CLOSERS.has(name) ? '\n\n' : '';
  }
  if (name === 'br') return '\n';
  if (name === 'ul' || name === 'ol') return '\n\n';
  return name === 'li' ? '• ' : '';
}

/**
 * Removes HTML tags (and `<script>`/`<style>` blocks whole), turning line breaks, paragraph ends and
 * list items into text breaks. One pass, linear in the length of the text, however it is shaped: the
 * obvious chain of regular expressions (`<[^>]*>`, `<script>...?</script>`) rescans the rest of the text
 * from every "<", which on a description of 200,000 characters made of "<" or unclosed tags froze the
 * tab of everyone who opened the job. Two things keep it linear: a "<" with no ">" anywhere after it
 * (or no closing tag for a script) ends the search for good, and the next ">" is remembered.
 */
function stripTags(text: string): string {
  const length = text.length;
  // The first ">" at or after `cacheFrom` (-1: there is none), remembered so a long run of "<" with a
  // ">" far away does not search for it again from every "<".
  let cacheFrom = 0;
  let cacheGt = -2; // -2: nothing cached yet
  const gtAfter = (from: number): number => {
    if (cacheGt !== -2 && from >= cacheFrom && (cacheGt === -1 || from <= cacheGt)) return cacheGt;
    cacheFrom = from;
    cacheGt = text.indexOf('>', from);
    return cacheGt;
  };
  const closedBlocks = new Set<string>(); // block names (script, style) known to have no closing tag left

  /** The index just past the closing tag of a `<script>`/`<style>` block that starts at `from`, or -1. */
  const endOfBlock = (name: string, from: number): number => {
    if (closedBlocks.has(name)) return -1;
    let position = from;
    for (;;) {
      const lt = text.indexOf('<', position);
      const gt = lt === -1 ? -1 : gtAfter(lt + 1);
      if (lt === -1 || gt === -1) {
        closedBlocks.add(name);
        return -1;
      }
      const tag = readTag(text, lt + 1, gt);
      if (tag.closing && tag.name === name && tag.bare) return gt + 1;
      position = lt + 1;
    }
  };

  const parts: string[] = [];
  let index = 0;
  while (index < length) {
    const lt = text.indexOf('<', index);
    if (lt === -1) {
      parts.push(text.slice(index));
      break;
    }
    parts.push(text.slice(index, lt));
    const gt = gtAfter(lt + 1);
    if (gt === -1) {
      // No ">" left anywhere: nothing after this point can be a tag.
      parts.push(text.slice(lt));
      break;
    }
    const tag = readTag(text, lt + 1, gt);
    if (!tag.closing && (tag.name === 'script' || tag.name === 'style')) {
      const end = endOfBlock(tag.name, gt + 1);
      if (end !== -1) {
        index = end;
        continue;
      }
    }
    parts.push(tagToText(tag));
    index = gt + 1;
  }
  return parts.join('');
}

/**
 * Job descriptions arrive as whatever the upstream feed sent: plain text, HTML,
 * or HTML that was entity-escaped on the way (Greenhouse). The result is only
 * ever rendered as React text children, so nothing here can inject markup;
 * this just makes the text readable by dropping tags and keeping paragraph and
 * list-item breaks. Returns paragraphs, blank ones removed.
 */
export function descriptionToParagraphs(description: string | null | undefined): string[] {
  if (typeof description !== 'string') return [];
  let text = description.replaceAll('\r\n', '\n');

  // Entity-escaped markup (`&lt;p&gt;...`) is decoded first so the tag pass below sees real tags.
  if (!text.includes('<') && /&lt;\/?[a-z]/i.test(text)) text = decodeEntities(text);

  text = stripTags(text);
  text = decodeEntities(text);

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

/** Total characters across paragraphs, to decide whether a "Show more" toggle is worth rendering. */
export function paragraphsLength(paragraphs: readonly string[]): number {
  return paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
}
