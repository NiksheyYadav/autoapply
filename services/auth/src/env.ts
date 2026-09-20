import { authEnvSchema, baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv } from '@atlas/config';
import { z } from 'zod';

export const authServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...authEnvSchema.shape,
  /**
   * OAuth sign-in providers. Left blank, a provider's routes 503 with
   * OAUTH_PROVIDER_UNAVAILABLE rather than crashing the service — same
   * "safe default, real driver is opt-in" shape as STORAGE_DRIVER/etc.
   */
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  MICROSOFT_CLIENT_ID: z.string().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().default(''),
  MICROSOFT_TENANT: z.string().min(1).default('common'),
  /** This service's own externally-reachable origin, used to build the OAuth redirect_uri. */
  OAUTH_REDIRECT_BASE_URL: z.string().min(1).default('http://localhost:4001'),
  /** Where the browser lands after an OAuth callback completes. */
  WEB_APP_URL: z.string().min(1).default('http://localhost:3000'),
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
