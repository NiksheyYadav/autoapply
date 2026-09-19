/**
 * No API gateway exists yet (docs/01 lists one as a future logical layer),
 * so the browser talks to each service directly on its own port. Every
 * value here has a working localhost default matching .env.example so
 * `pnpm dev:web` works out of the box alongside `pnpm dev:auth` etc.
 */
export const SERVICE_URLS = {
  auth: process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ?? 'http://localhost:4001',
  profile: process.env.NEXT_PUBLIC_PROFILE_SERVICE_URL ?? 'http://localhost:4002',
  jobs: process.env.NEXT_PUBLIC_JOBS_SERVICE_URL ?? 'http://localhost:4003',
  matching: process.env.NEXT_PUBLIC_MATCHING_SERVICE_URL ?? 'http://localhost:4004',
  applications: process.env.NEXT_PUBLIC_APPLICATIONS_SERVICE_URL ?? 'http://localhost:4005',
  referrals: process.env.NEXT_PUBLIC_REFERRALS_SERVICE_URL ?? 'http://localhost:4006',
  outreach: process.env.NEXT_PUBLIC_OUTREACH_SERVICE_URL ?? 'http://localhost:4007',
} as const;
