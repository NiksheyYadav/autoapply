import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema, supabaseAuthEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const jobsServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
  /**
   * Comma-separated `auth.users` ids allowed to act on GLOBAL data such as the
   * shared jobs catalog (see `requirePlatformAdmin` in @atlas/auth-kit).
   * Empty/unset means nobody.
   */
  PLATFORM_ADMIN_USER_IDS: z.string().default(''),
});

export type JobsServiceEnv = z.infer<typeof jobsServiceEnvSchema>;

export function loadJobsServiceEnv(source: Record<string, string | undefined> = process.env): JobsServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.JOBS_SERVICE_PORT };
  return loadEnv('jobs-service', jobsServiceEnvSchema, normalized);
}
