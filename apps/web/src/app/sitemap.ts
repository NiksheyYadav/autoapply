import type { MetadataRoute } from 'next';
import { PUBLIC_PATHS } from '../lib/seo';
import { siteUrl } from '../lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteUrl().origin;
  return PUBLIC_PATHS.map((path) => ({ url: `${origin}${path}` }));
}
