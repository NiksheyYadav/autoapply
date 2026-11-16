const LOCAL_ORIGIN = 'http://localhost:3000';

/**
 * Absolute origin of the deployed site, for canonical URLs, Open Graph tags,
 * robots.txt and the sitemap. Resolved on the server at build time.
 *
 * Set NEXT_PUBLIC_SITE_URL to the public origin (e.g. https://atlas.example).
 * On Vercel it falls back to the project's production domain, which Vercel
 * injects as a bare host (VERCEL_PROJECT_PRODUCTION_URL); anywhere else it
 * falls back to localhost, which is only right for local development.
 */
export function siteUrl(): URL {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || LOCAL_ORIGIN;
  const withProtocol = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  try {
    return new URL(withProtocol);
  } catch {
    return new URL(LOCAL_ORIGIN);
  }
}
