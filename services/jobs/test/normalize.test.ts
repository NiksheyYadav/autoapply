import { describe, expect, it } from 'vitest';
import type { RawJobPosting } from '@atlas/types';
import {
  coerceEmploymentType,
  coerceRemoteType,
  computeJobHash,
  estimateSpamScore,
  normalizeCompanyName,
} from '../src/lib/normalize.js';

describe('normalizeCompanyName', () => {
  it('lowercases, trims, and strips common suffixes', () => {
    expect(normalizeCompanyName('Acme Corp.')).toBe('acme');
    expect(normalizeCompanyName('  Acme   Inc  ')).toBe('acme');
    expect(normalizeCompanyName('Acme LLC')).toBe('acme');
  });

  it('leaves names without a suffix alone beyond case/whitespace', () => {
    expect(normalizeCompanyName('Analytical Engines')).toBe('analytical engines');
  });
});

describe('computeJobHash', () => {
  it('is stable across case and whitespace differences', () => {
    const a = computeJobHash('Acme Corp', 'Staff Engineer', 'Remote', 'remote');
    const b = computeJobHash('  ACME   corp  ', '  staff   engineer ', 'remote', 'remote');
    expect(a).toBe(b);
  });

  it('differs when the title or company differs', () => {
    const a = computeJobHash('Acme', 'Staff Engineer', null, 'remote');
    const b = computeJobHash('Acme', 'Senior Engineer', null, 'remote');
    expect(a).not.toBe(b);
  });

  it('produces a 64-character hex string', () => {
    expect(computeJobHash('Acme', 'Engineer', null, 'unknown')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('coerceRemoteType', () => {
  it.each([
    ['Fully Remote', 'remote'],
    ['Hybrid (3 days onsite)', 'hybrid'],
    ['On-site', 'onsite'],
    ['Some odd string', 'unknown'],
    [null, 'unknown'],
  ] as const)('maps "%s" to %s', (input, expected) => {
    expect(coerceRemoteType(input)).toBe(expected);
  });
});

describe('coerceEmploymentType', () => {
  it.each([
    ['Full-time', 'full_time'],
    ['Part time', 'part_time'],
    ['Contractor', 'contract'],
    ['Summer Internship', 'internship'],
    [undefined, 'unknown'],
  ] as const)('maps "%s" to %s', (input, expected) => {
    expect(coerceEmploymentType(input)).toBe(expected);
  });
});

describe('estimateSpamScore', () => {
  const base: RawJobPosting = {
    source: 'manual',
    external_id: null,
    title: 'Software Engineer',
    company_name: 'Acme',
    description: 'A'.repeat(100),
    apply_url: 'https://acme.example/apply',
  };

  it('scores a complete posting as low-risk', () => {
    expect(estimateSpamScore(base)).toBe(0);
  });

  it('penalizes a missing apply_url, a short title, or a thin description', () => {
    expect(estimateSpamScore({ ...base, apply_url: null })).toBeGreaterThan(0);
    expect(estimateSpamScore({ ...base, title: 'X' })).toBeGreaterThan(0);
    expect(estimateSpamScore({ ...base, description: 'short' })).toBeGreaterThan(0);
  });

  it('never exceeds 1', () => {
    expect(estimateSpamScore({ ...base, apply_url: null, title: 'X', description: null })).toBeLessThanOrEqual(1);
  });
});
