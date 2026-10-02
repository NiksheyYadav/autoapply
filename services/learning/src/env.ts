import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema, supabaseAuthEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const learningServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
});

export type LearningServiceEnv = z.infer<typeof learningServiceEnvSchema>;

export function loadLearningServiceEnv(
  source: Record<string, string | undefined> = process.env,
): LearningServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.LEARNING_SERVICE_PORT };
  return loadEnv('learning-service', learningServiceEnvSchema, normalized);
}
