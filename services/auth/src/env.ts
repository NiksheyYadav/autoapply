import {
  baseEnvSchema,
  databaseEnvSchema,
  httpEnvSchema,
  loadEnv,
  storageEnvSchema,
  supabaseAuthEnvSchema,
} from '@atlas/config';
import { z } from 'zod';

export const authServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
  /**
   * Account deletion removes a user's stored resume files, so this service
   * needs the same storage settings as profile-service. On Vercel all services
   * share one project's environment, so nothing extra is set there.
   */
  ...storageEnvSchema.shape,
  /**
   * Budgets for the two account-privacy routes, per client address per window.
   * They replace (do not add to) the general RATE_LIMIT_* budget on those
   * routes, and the delete budget is deliberately the smaller one. Counters
   * live in each function instance's memory, like the general limiter.
   */
  PRIVACY_EXPORT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  PRIVACY_DELETE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(3),
  PRIVACY_RATE_LIMIT_WINDOW: z.string().min(1).default('1 hour'),
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
