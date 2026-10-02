import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema, supabaseAuthEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const applicationsServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
});

export type ApplicationsServiceEnv = z.infer<typeof applicationsServiceEnvSchema>;

export function loadApplicationsServiceEnv(
  source: Record<string, string | undefined> = process.env,
): ApplicationsServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.APPLICATIONS_SERVICE_PORT };
  return loadEnv('applications-service', applicationsServiceEnvSchema, normalized);
}
