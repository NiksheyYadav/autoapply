import { authEnvSchema, baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv } from '@atlas/config';
import { z } from 'zod';

export const authServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...authEnvSchema.shape,
});

export type AuthServiceEnv = z.infer<typeof authServiceEnvSchema>;

/**
 * Local dev runs every service from one shared `.env`, so ports are
 * disambiguated per-service (`AUTH_SERVICE_PORT`, docs/10 § Config layers).
 * Production runs one container per service and can set `PORT` directly.
 */
export function loadAuthServiceEnv(
  source: Record<string, string | undefined> = process.env,
): AuthServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.AUTH_SERVICE_PORT };
  return loadEnv('auth-service', authServiceEnvSchema, normalized);
}
