import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT_PATH, safeNextPath } from '../src/lib/safe-redirect';

const ORIGIN = 'https://atlas.example';

describe('safeNextPath', () => {
  it.each([
    ['/dashboard'],
    ['/dashboard/resume'],
    ['/reset-password'],
    ['/'],
    ['/dashboard?tab=jobs&page=2'],
    ['/dashboard#section'],
    ['/path//with//inner//slashes'],
    ['/caf%C3%A9'],
  ])('allows the same-origin path %s unchanged', (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([[null], [undefined], ['']])('falls back to the default for %s', (value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
  });

  it.each([
    // userinfo / lookalike-host tricks against `${origin}${next}`
    ['@evil.com'],
    ['.evil.com'],
    [':443@evil.com'],
    // protocol-relative
    ['//evil.com'],
    ['///evil.com'],
    ['//evil.com/dashboard'],
    // absolute and scheme URLs
    ['https://evil.com'],
    ['http://evil.com/dashboard'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    // not a path at all
    ['dashboard'],
    ['evil.com'],
    [' /dashboard'],
    // backslashes are slashes to browsers
    ['/\\evil.com'],
    ['\\\\evil.com'],
    ['\\evil.com'],
    ['/dashboard\\..\\..'],
    // control characters that URL parsers strip
    ['/\t/evil.com'],
    ['/\n/evil.com'],
    ['/\r/evil.com'],
    ['/dashboard\u0000'],
    // percent-encoded variants of the above
    ['/%2F/evil.com'],
    ['/%2f/evil.com'],
    ['/%5Cevil.com'],
    ['/%09/evil.com'],
    ['/%0A/evil.com'],
    // malformed escapes can't be validated, so are refused
    ['/%E0%A4%A'],
    ['/%'],
  ])('rejects %j', (value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects absurdly long values', () => {
    expect(safeNextPath(`/${'a'.repeat(5000)}`)).toBe(DEFAULT_NEXT_PATH);
  });

  it('uses the supplied fallback', () => {
    expect(safeNextPath('//evil.com', '/login')).toBe('/login');
    expect(safeNextPath(null, '/login')).toBe('/login');
    expect(safeNextPath('/dashboard', '/login')).toBe('/dashboard');
  });

  it('never yields a URL that leaves the origin once resolved against it', () => {
    const attacks = ['@evil.com', '.evil.com', '//evil.com', '/\\evil.com', '/\t/evil.com', '/%2F/evil.com', 'https://evil.com'];
    for (const attack of attacks) {
      const resolved = new URL(safeNextPath(attack), ORIGIN);
      expect(resolved.origin).toBe(ORIGIN);
    }
  });
});
