import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const learningServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  /** Verifies auth-service's JWTs; must match its JWT_SECRET/ISSUER/AUDIENCE. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('atlas'),
  JWT_AUDIENCE: z.string().min(1).default('atlas-clients'),
});

export type LearningServiceEnv = z.infer<typeof learningServiceEnvSchema>;

export function loadLearningServiceEnv(
  source: Record<string, string | undefined> = process.env,
): LearningServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.LEARNING_SERVICE_PORT };
  return loadEnv('learning-service', learningServiceEnvSchema, normalized);
}
