/**
 * All backend services deploy as one Vercel project (root vercel.json routes
 * /v1/<service>/* to each service's function), so in production every entry
 * below is the same origin. Locally, each service still runs on its own port
 * (`pnpm dev:auth` etc.) via .env.example's per-service ports, so the
 * per-service fallbacks are kept for local dev.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

export const SERVICE_URLS = {
  auth: API_BASE_URL ?? process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ?? 'http://localhost:4001',
  profile: API_BASE_URL ?? process.env.NEXT_PUBLIC_PROFILE_SERVICE_URL ?? 'http://localhost:4002',
  jobs: API_BASE_URL ?? process.env.NEXT_PUBLIC_JOBS_SERVICE_URL ?? 'http://localhost:4003',
  matching: API_BASE_URL ?? process.env.NEXT_PUBLIC_MATCHING_SERVICE_URL ?? 'http://localhost:4004',
  applications: API_BASE_URL ?? process.env.NEXT_PUBLIC_APPLICATIONS_SERVICE_URL ?? 'http://localhost:4005',
  referrals: API_BASE_URL ?? process.env.NEXT_PUBLIC_REFERRALS_SERVICE_URL ?? 'http://localhost:4006',
  outreach: API_BASE_URL ?? process.env.NEXT_PUBLIC_OUTREACH_SERVICE_URL ?? 'http://localhost:4007',
} as const;
