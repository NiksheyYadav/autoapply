import { describe, expect, it } from 'vitest';
import { toSafeApplyUrl } from '../src/lib/apply-url.js';

describe('toSafeApplyUrl', () => {
  it('passes http and https URLs through in canonical form', () => {
    expect(toSafeApplyUrl('https://boards.example.com/jobs/42?gh_src=abc')).toBe('https://boards.example.com/jobs/42?gh_src=abc');
    expect(toSafeApplyUrl('http://careers.example.com/apply')).toBe('http://careers.example.com/apply');
    expect(toSafeApplyUrl('HTTPS://Example.COM')).toBe('https://example.com/');
  });

  it('returns null for missing values', () => {
    expect(toSafeApplyUrl(null)).toBeNull();
    expect(toSafeApplyUrl(undefined)).toBeNull();
    expect(toSafeApplyUrl('')).toBeNull();
  });

  it('returns null for text that is not a URL', () => {
    expect(toSafeApplyUrl('not a url')).toBeNull();
    expect(toSafeApplyUrl('/relative/path')).toBeNull();
    expect(toSafeApplyUrl('example.com/apply')).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://files.example.com/job.pdf',
    'mailto:jobs@example.com',
    'tel:+15555550100',
    'blob:https://example.com/3f8c1a2e',
  ])('returns null for the non-http(s) scheme in %s', (raw) => {
    expect(toSafeApplyUrl(raw)).toBeNull();
  });

  it('returns null for URLs that embed credentials to disguise the real host', () => {
    expect(toSafeApplyUrl('https://careers.example.com@evil.example/apply')).toBeNull();
    expect(toSafeApplyUrl('https://user:pass@example.com/apply')).toBeNull();
  });
});
