import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema } from '@atlas/config';
import { z } from 'zod';

/**
 * No `authEnvSchema` slice here: matching-service has no protected routes to
 * verify a JWT against — it only exposes `/health` and otherwise runs as an
 * event consumer (docs/06 § Worker layout).
 */
export const matchingServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  /**
   * Bearer secret for `/internal/drain`, which Vercel Cron sends as
   * `Authorization: Bearer $CRON_SECRET` when this variable is set. Unset, the
   * route answers 503 and never runs a drain.
   */
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters').optional(),
});

export type MatchingServiceEnv = z.infer<typeof matchingServiceEnvSchema>;

export function loadMatchingServiceEnv(
  source: Record<string, string | undefined> = process.env,
): MatchingServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.MATCHING_SERVICE_PORT };
  return loadEnv('matching-service', matchingServiceEnvSchema, normalized);
}
