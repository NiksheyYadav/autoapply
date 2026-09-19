import {
  baseEnvSchema,
  databaseEnvSchema,
  httpEnvSchema,
  loadEnv,
  messagingEnvSchema,
  storageEnvSchema,
} from '@atlas/config';
import { z } from 'zod';

export const profileServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  ...storageEnvSchema.shape,
  /** Verifies auth-service's JWTs; must match its JWT_SECRET/ISSUER/AUDIENCE. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('atlas'),
  JWT_AUDIENCE: z.string().min(1).default('atlas-clients'),
});

export type ProfileServiceEnv = z.infer<typeof profileServiceEnvSchema>;

export function loadProfileServiceEnv(
  source: Record<string, string | undefined> = process.env,
): ProfileServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.PROFILE_SERVICE_PORT };
  return loadEnv('profile-service', profileServiceEnvSchema, normalized);
}
