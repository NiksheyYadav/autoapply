import {
  baseEnvSchema,
  databaseEnvSchema,
  httpEnvSchema,
  loadEnv,
  messagingEnvSchema,
  storageEnvSchema,
  supabaseAuthEnvSchema,
} from '@atlas/config';
import { z } from 'zod';

export const profileServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  ...storageEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
});

export type ProfileServiceEnv = z.infer<typeof profileServiceEnvSchema>;

export function loadProfileServiceEnv(
  source: Record<string, string | undefined> = process.env,
): ProfileServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.PROFILE_SERVICE_PORT };
  return loadEnv('profile-service', profileServiceEnvSchema, normalized);
}
