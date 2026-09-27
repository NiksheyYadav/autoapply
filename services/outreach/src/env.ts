import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema, supabaseAuthEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const outreachServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
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
