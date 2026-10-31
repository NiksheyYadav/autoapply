import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

describe('security headers', async () => {
  const rules = (await nextConfig.headers?.()) as HeaderRule[];
  const pages = rules.find((rule) => rule.source.includes('(?!_next/static'));
  const header = (name: string) => pages?.headers.find((entry) => entry.key.toLowerCase() === name.toLowerCase())?.value;

  it('applies to pages but not to the fingerprinted bundles, which keep their long-lived cache headers', () => {
    expect(pages).toBeDefined();
    const matcher = new RegExp(`^${pages!.source}$`);
    expect(matcher.test('/dashboard')).toBe(true);
    expect(matcher.test('/login')).toBe(true);
    expect(matcher.test('/_next/static/chunks/app.js')).toBe(false);
  });

  it('forbids framing in both the old and the current way', () => {
    expect(header('X-Frame-Options')).toBe('DENY');
    expect(header('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('stops content-type sniffing and limits what is sent to other sites', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(['no-referrer', 'strict-origin-when-cross-origin', 'same-origin']).toContain(header('Referrer-Policy'));
  });

  it('does not announce the framework', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('switches off browser features the app does not use', () => {
    const policy = header('Permissions-Policy') ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation']) expect(policy).toContain(`${feature}=()`);
  });
});
