import { describe, expect, it } from 'vitest';
import {
  descriptionToParagraphs,
  employmentTypeLabel,
  formatSalary,
  matchPercent,
  paragraphsLength,
  remoteTypeLabel,
} from '../src/components/jobs/job-view-model';

describe('matchPercent', () => {
  it('turns a 0-1 score into a whole percent', () => {
    expect(matchPercent(0.724)).toBe(72);
    expect(matchPercent(0.725)).toBe(73);
    expect(matchPercent(0)).toBe(0);
    expect(matchPercent(1)).toBe(100);
  });

  it('clamps out-of-range scores', () => {
    expect(matchPercent(1.4)).toBe(100);
    expect(matchPercent(-0.2)).toBe(0);
  });

  it.each([[null], [undefined], ['0.5'], [Number.NaN], [Number.POSITIVE_INFINITY]])('is null for %j', (value) => {
    expect(matchPercent(value)).toBeNull();
  });
});

describe('labels', () => {
  it('labels known remote and employment types', () => {
    expect(remoteTypeLabel('remote')).toBe('Remote');
    expect(remoteTypeLabel('onsite')).toBe('On-site');
    expect(employmentTypeLabel('full_time')).toBe('Full-time');
    expect(employmentTypeLabel('internship')).toBe('Internship');
  });

  it('says "not stated" rather than a bare "unknown"', () => {
    expect(remoteTypeLabel('unknown')).toMatch(/not stated/i);
    expect(employmentTypeLabel('unknown')).toMatch(/not stated/i);
  });

  it('still renders a value added on the backend later', () => {
    expect(remoteTypeLabel('flexible_hours')).toBe('flexible hours');
  });
});

describe('formatSalary', () => {
  const base = { salary_min: null, salary_max: null, salary_currency: null };

  it('is null when the posting states no salary', () => {
    expect(formatSalary(base)).toBeNull();
    expect(formatSalary({ ...base, salary_currency: 'USD' })).toBeNull();
  });

  it('formats a range, a floor, a ceiling and a single figure', () => {
    expect(formatSalary({ salary_min: 120000, salary_max: 150000, salary_currency: 'USD' })).toBe('$120,000 – $150,000');
    expect(formatSalary({ salary_min: 90000, salary_max: null, salary_currency: 'USD' })).toBe('From $90,000');
    expect(formatSalary({ salary_min: null, salary_max: 90000, salary_currency: 'USD' })).toBe('Up to $90,000');
    expect(formatSalary({ salary_min: 80000, salary_max: 80000, salary_currency: 'USD' })).toBe('$80,000');
  });

  it('shows plain digits when no currency is given', () => {
    expect(formatSalary({ salary_min: 50000, salary_max: 60000, salary_currency: null })).toBe('50,000 – 60,000');
  });

  it('does not throw on a currency code the runtime does not know', () => {
    expect(formatSalary({ salary_min: 50000, salary_max: null, salary_currency: 'ZZZ1' })).toBe('From ZZZ1 50,000');
  });
});

describe('descriptionToParagraphs', () => {
  it('is empty for missing or blank descriptions', () => {
    expect(descriptionToParagraphs(null)).toEqual([]);
    expect(descriptionToParagraphs(undefined)).toEqual([]);
    expect(descriptionToParagraphs('   \n\n  ')).toEqual([]);
  });

  it('splits plain text on blank lines and keeps single line breaks', () => {
    expect(descriptionToParagraphs('First paragraph.\n\nSecond line one\nsecond line two\r\n\r\nThird.')).toEqual([
      'First paragraph.',
      'Second line one\nsecond line two',
      'Third.',
    ]);
  });

  it('strips HTML tags but keeps the text and the structure', () => {
    const html = '<h2>About</h2><p>We build <strong>robots</strong>.</p><ul><li>TypeScript</li><li>Postgres</li></ul>';
    expect(descriptionToParagraphs(html)).toEqual(['About', 'We build robots.', '• TypeScript\n• Postgres']);
  });

  it('reads entity-escaped HTML, as some feeds deliver it', () => {
    expect(descriptionToParagraphs('&lt;p&gt;Join us &amp;amp; build things&lt;/p&gt;&lt;p&gt;Second&lt;/p&gt;')).toEqual([
      'Join us & build things',
      'Second',
    ]);
  });

  it('decodes common entities in otherwise plain text', () => {
    expect(descriptionToParagraphs('R&amp;D &mdash; Q&#39;s &#x26; A&nbsp;team')).toEqual(["R&D — Q's & A team"]);
  });

  it('leaves unknown or invalid entities as written', () => {
    expect(descriptionToParagraphs('a &bogus; b &#99999999; c')).toEqual(['a &bogus; b &#99999999; c']);
  });

  it('drops script and style blocks entirely', () => {
    expect(descriptionToParagraphs('Hello<script>alert(1)</script> world<style>p{color:red}</style>')).toEqual(['Hello world']);
  });

  it('only ever produces text: no tag survives', () => {
    const hostile = '<img src=x onerror=alert(1)><a href="javascript:alert(1)">click</a><svg onload=alert(1)>';
    const result = descriptionToParagraphs(hostile).join('\n');
    expect(result).not.toMatch(/<|>/);
    expect(result).toBe('click');
  });
});

describe('paragraphsLength', () => {
  it('sums the characters', () => {
    expect(paragraphsLength(['abc', 'de'])).toBe(5);
    expect(paragraphsLength([])).toBe(0);
  });
});
