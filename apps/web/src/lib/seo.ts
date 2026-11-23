import { siteUrl } from './site';

/**
 * Public-facing SEO copy. Every claim here must come from
 * docs/01_product_architecture.md: no metrics, customers, certifications or pricing.
 */
export const SITE_NAME = 'Project Atlas';

export const SITE_DESCRIPTION =
  'Project Atlas is a multi-tenant AI job automation platform for individuals, universities and colleges, and enterprises.';

/** Routes that are public and meant to be indexed. */
export const PUBLIC_PATHS = ['/', '/privacy'] as const;

export const LLMS_TXT = `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

## What it does

- Imports profile data, then parses and normalizes the resume.
- Discovers jobs continuously and scores opportunities against the profile.
- Prepares ATS-friendly resume variants.
- Submits and tracks applications.
- Targets relevant people for referrals and outreach.
- Updates ranking models from outcomes.

## Platform

- Core services: auth, profiles, jobs, applications, referrals, outreach, analytics.
- AI services: resume parsing, ranking, optimization, learning.

## Pages

- [Home](${siteUrl().origin}/)
- [Privacy](${siteUrl().origin}/privacy)
`;

export function softwareApplicationJsonLd(origin: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'BusinessApplication',
    description: SITE_DESCRIPTION,
    url: origin,
  };
}
