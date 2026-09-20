import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const outreachServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  /** Verifies auth-service's JWTs; must match its JWT_SECRET/ISSUER/AUDIENCE. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('atlas'),
  JWT_AUDIENCE: z.string().min(1).default('atlas-clients'),
  /**
   * `local` just logs the send (safe default, no external dependency). `smtp`
   * is not implemented yet — mirrors `@atlas/storage`'s `s3` driver, which
   * throws a clear error at factory time rather than pretending to work.
   */
  OUTREACH_TRANSPORT_DRIVER: z.enum(['local', 'smtp']).default('local'),
});

export type OutreachServiceEnv = z.infer<typeof outreachServiceEnvSchema>;

export function loadOutreachServiceEnv(
  source: Record<string, string | undefined> = process.env,
): OutreachServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.OUTREACH_SERVICE_PORT };
  return loadEnv('outreach-service', outreachServiceEnvSchema, normalized);
}
