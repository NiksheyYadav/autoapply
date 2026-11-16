import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema, supabaseAuthEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const applicationsServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
  /**
   * No worker consumes `queued` applications yet, so `mode: "auto"` would leave
   * the user stuck in `queued` forever. Until a submission worker ships,
   * POST /v1/applications rejects `auto` unless this is explicitly turned on.
   */
  APPLICATIONS_AUTO_MODE_ENABLED: z.stringbool().default(false),
});

export type ApplicationsServiceEnv = z.infer<typeof applicationsServiceEnvSchema>;

export function loadApplicationsServiceEnv(
  source: Record<string, string | undefined> = process.env,
): ApplicationsServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.APPLICATIONS_SERVICE_PORT };
  return loadEnv('applications-service', applicationsServiceEnvSchema, normalized);
}
