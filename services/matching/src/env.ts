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
});

export type MatchingServiceEnv = z.infer<typeof matchingServiceEnvSchema>;

export function loadMatchingServiceEnv(
  source: Record<string, string | undefined> = process.env,
): MatchingServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.MATCHING_SERVICE_PORT };
  return loadEnv('matching-service', matchingServiceEnvSchema, normalized);
}
