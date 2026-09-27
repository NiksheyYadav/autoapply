/**
 * All backend services deploy as one Vercel project (root vercel.json routes
 * /v1/<service>/* to each service's function), so in production every entry
 * below is the same origin — same approach as apps/web's lib/config.ts.
 * Locally, each service still runs on its own port via .env.example.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

export const SERVICE_URLS = {
  auth: API_BASE_URL ?? process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ?? 'http://localhost:4001',
  applications: API_BASE_URL ?? process.env.NEXT_PUBLIC_APPLICATIONS_SERVICE_URL ?? 'http://localhost:4005',
  learning: API_BASE_URL ?? process.env.NEXT_PUBLIC_LEARNING_SERVICE_URL ?? 'http://localhost:4008',
  analytics: API_BASE_URL ?? process.env.NEXT_PUBLIC_ANALYTICS_SERVICE_URL ?? 'http://localhost:4009',
} as const;
