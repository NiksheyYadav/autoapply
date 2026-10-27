import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema, supabaseAuthEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const referralsServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
  /**
   * Bearer secret for `/internal/drain`, which Vercel Cron sends as
   * `Authorization: Bearer $CRON_SECRET` when this variable is set. Unset, the
   * route answers 503 and never runs a drain.
   */
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters').optional(),
});

export type ReferralsServiceEnv = z.infer<typeof referralsServiceEnvSchema>;

export function loadReferralsServiceEnv(
  source: Record<string, string | undefined> = process.env,
): ReferralsServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.REFERRALS_SERVICE_PORT };
  return loadEnv('referrals-service', referralsServiceEnvSchema, normalized);
}
