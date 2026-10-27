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

  text = text
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*(?:ul|ol)[^>]*>/gi, '\n\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\s*\/\s*li\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|tr)\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  text = decodeEntities(text);

  return text
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n'),
    )
    .filter((paragraph) => paragraph.length > 0);
}

/** Total characters across paragraphs, to decide whether a "Show more" toggle is worth rendering. */
export function paragraphsLength(paragraphs: readonly string[]): number {
  return paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
}
