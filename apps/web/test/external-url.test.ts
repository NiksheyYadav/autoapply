import { describe, expect, it } from 'vitest';
import { externalUrlHost, safeExternalUrl } from '../src/components/applications/external-url';

describe('safeExternalUrl', () => {
  it.each([
    ['https://boards.greenhouse.io/acme/jobs/123', 'https://boards.greenhouse.io/acme/jobs/123'],
    ['http://jobs.example.com/apply', 'http://jobs.example.com/apply'],
    ['https://jobs.lever.co/acme/abc?lever-source=atlas#apply', 'https://jobs.lever.co/acme/abc?lever-source=atlas#apply'],
    ['  https://example.com/apply  ', 'https://example.com/apply'],
    // Returned in the browser's normalised form, so what we checked is what gets opened.
    ['HTTPS://Example.COM/Apply', 'https://example.com/Apply'],
    ['https://example.com', 'https://example.com/'],
    ['https://example.com:8443/apply', 'https://example.com:8443/apply'],
  ])('accepts %j', (input, expected) => {
    expect(safeExternalUrl(input)).toBe(expected);
  });

  it.each([
    ['javascript:alert(1)'],
    ['JAVASCRIPT:alert(1)'],
    ['  javascript:alert(1)'],
    ['java\tscript:alert(1)'],
    ['java\nscript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['file:///etc/passwd'],
    ['blob:https://example.com/uuid'],
    ['ftp://example.com/resume'],
    ['mailto:jobs@example.com'],
    ['tel:+15555550100'],
    ['about:blank'],
  ])('rejects the non-http(s) URL %j', (input) => {
    expect(safeExternalUrl(input)).toBeNull();
  });

  it.each([
    [''],
    ['   '],
    ['example.com/apply'],
    ['/relative/path'],
    ['//example.com/apply'],
    ['https://'],
    ['not a url'],
    ['https://exa mple.com'],
    ['https://example.com/a b'],
    ['https://example.com/\u0000'],
    ['https://example.com/\u0085'],
  ])('rejects malformed or relative input %j', (input) => {
    expect(safeExternalUrl(input)).toBeNull();
  });

  it('rejects embedded credentials, the "trusted.com@evil.com" lookalike trick', () => {
    expect(safeExternalUrl('https://trusted.example.com@evil.example.net/apply')).toBeNull();
    expect(safeExternalUrl('https://user:pass@example.com/apply')).toBeNull();
    expect(safeExternalUrl('https://user@example.com/apply')).toBeNull();
  });

  it('rejects absurdly long URLs', () => {
    expect(safeExternalUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
  });

  it.each([[null], [undefined], [42], [{}], [['https://example.com']], [true]])('rejects the non-string %j', (input) => {
    expect(safeExternalUrl(input)).toBeNull();
  });

  it('only ever returns an http(s) URL', () => {
    const inputs = ['https://a.example', 'javascript:1', 'data:,x', 'http://b.example/p', '//c.example', 'file:///x'];
    for (const input of inputs) {
      const result = safeExternalUrl(input);
      if (result !== null) expect(new URL(result).protocol).toMatch(/^https?:$/);
    }
  });
});

describe('externalUrlHost', () => {
  it('returns the host without a leading www.', () => {
    expect(externalUrlHost('https://www.example.com/jobs/1')).toBe('example.com');
    expect(externalUrlHost('https://boards.greenhouse.io/acme')).toBe('boards.greenhouse.io');
  });

  it('is null for anything safeExternalUrl refuses', () => {
    expect(externalUrlHost('javascript:alert(1)')).toBeNull();
    expect(externalUrlHost(null)).toBeNull();
  });
});
