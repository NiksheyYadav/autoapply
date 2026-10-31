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

export const learningServiceEnvSchema = z.object({
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
  CRON_SECRET: cronSecretSchema.optional(),
  /**
   * Comma-separated `auth.users` ids allowed to read cross-tenant aggregates
   * (see `requirePlatformAdmin` in @atlas/auth-kit). Empty/unset means nobody.
   */
  PLATFORM_ADMIN_USER_IDS: z.string().default(''),
});

export type LearningServiceEnv = z.infer<typeof learningServiceEnvSchema>;

export function loadLearningServiceEnv(
  source: Record<string, string | undefined> = process.env,
): LearningServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.LEARNING_SERVICE_PORT };
  return loadEnv('learning-service', learningServiceEnvSchema, normalized);
}
