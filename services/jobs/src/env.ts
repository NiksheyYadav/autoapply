import {
  baseEnvSchema,
  cronSecretSchema,
  databaseEnvSchema,
  httpEnvSchema,
  loadEnv,
  messagingEnvSchema,
  supabaseAuthEnvSchema,
} from '@atlas/config';
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
  /**
   * Bearer secret for `/internal/jobs/ingest-sources`, the scheduled job-board
   * ingestion (a scheduler sends `Authorization: Bearer $CRON_SECRET`). Unset,
   * the route answers 503 and never runs.
   */
  CRON_SECRET: cronSecretSchema.optional(),
  /**
   * An email address or URL where the operator of a job board can reach whoever
   * runs this reader, appended to the User-Agent it sends. Printable ASCII only
   * (it goes into a header). Optional.
   */
  JOB_SOURCE_CONTACT: z
    .string()
    .max(200)
    .regex(/^[\x20-\x7e]*$/, 'JOB_SOURCE_CONTACT must be printable ASCII')
    .optional(),
});

export type JobsServiceEnv = z.infer<typeof jobsServiceEnvSchema>;

export function loadJobsServiceEnv(source: Record<string, string | undefined> = process.env): JobsServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.JOBS_SERVICE_PORT };
  return loadEnv('jobs-service', jobsServiceEnvSchema, normalized);
}
