import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema, supabaseAuthEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const referralsServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
});

export type ReferralsServiceEnv = z.infer<typeof referralsServiceEnvSchema>;

export function loadReferralsServiceEnv(
  source: Record<string, string | undefined> = process.env,
): ReferralsServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.REFERRALS_SERVICE_PORT };
  return loadEnv('referrals-service', referralsServiceEnvSchema, normalized);
}
