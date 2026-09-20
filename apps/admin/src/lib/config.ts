/**
 * No API gateway exists yet (docs/01 lists one as a future logical layer),
 * so the browser talks to each service directly on its own port — same
 * approach as apps/web's lib/config.ts.
 */
export const SERVICE_URLS = {
  auth: process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ?? 'http://localhost:4001',
  applications: process.env.NEXT_PUBLIC_APPLICATIONS_SERVICE_URL ?? 'http://localhost:4005',
  learning: process.env.NEXT_PUBLIC_LEARNING_SERVICE_URL ?? 'http://localhost:4008',
  analytics: process.env.NEXT_PUBLIC_ANALYTICS_SERVICE_URL ?? 'http://localhost:4009',
} as const;
