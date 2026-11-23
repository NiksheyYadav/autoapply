import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import robots from '../src/app/robots';
import { GET } from '../src/app/llms.txt/route';
import sitemap from '../src/app/sitemap';
import { LLMS_TXT, PUBLIC_PATHS, SITE_DESCRIPTION, SITE_NAME, softwareApplicationJsonLd } from '../src/lib/seo';

describe('seo', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://atlas.example';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved;
  });

  it('robots disallows private areas and points at the sitemap', () => {
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0]! : result.rules;
    expect(rule.disallow).toEqual(expect.arrayContaining(['/dashboard', '/api', '/auth']));
    expect(result.sitemap).toBe('https://atlas.example/sitemap.xml');
  });

  it('sitemap lists only the public paths, as absolute URLs', () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual(PUBLIC_PATHS.map((path) => `https://atlas.example${path}`));
    for (const url of urls) expect(url).toMatch(/^https:\/\//);
    expect(urls.join(' ')).not.toContain('dashboard');
  });

  it('serves llms.txt as plain text', async () => {
    const response = GET();
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('Project Atlas');
  });

  it('JSON-LD describes the software without offers or ratings', () => {
    const ld = softwareApplicationJsonLd('https://atlas.example');
    expect(ld['@type']).toBe('SoftwareApplication');
    expect(ld.name).toBe('Project Atlas');
    expect(ld).not.toHaveProperty('offers');
    expect(ld).not.toHaveProperty('aggregateRating');
  });

  it('copy makes no metric, price, customer or certification claims', () => {
    const strings = [SITE_NAME, SITE_DESCRIPTION, LLMS_TXT, JSON.stringify(softwareApplicationJsonLd('https://atlas.example'))];
    for (const text of strings) {
      expect(text).not.toMatch(/\d%/);
      expect(text).not.toContain('$');
      expect(text.toLowerCase()).not.toContain('customers');
      expect(text.toLowerCase()).not.toContain('certified');
    }
  });
});
