import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema, supabaseAuthEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const analyticsServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
});

export type AnalyticsServiceEnv = z.infer<typeof analyticsServiceEnvSchema>;

export function loadAnalyticsServiceEnv(
  source: Record<string, string | undefined> = process.env,
): AnalyticsServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.ANALYTICS_SERVICE_PORT };
  return loadEnv('analytics-service', analyticsServiceEnvSchema, normalized);
}
