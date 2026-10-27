import {
  baseEnvSchema,
  databaseEnvSchema,
  httpEnvSchema,
  loadEnv,
  supabaseAuthEnvSchema,
} from '@atlas/config';
import { z } from 'zod';

/**
 * No messaging config: this service never publishes or consumes events, and
 * nothing in it sends email or any other outbound message.
 */
export const adminServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...supabaseAuthEnvSchema.shape,
});

export type AdminServiceEnv = z.infer<typeof adminServiceEnvSchema>;

export function loadAdminServiceEnv(
  source: Record<string, string | undefined> = process.env,
): AdminServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.ADMIN_SERVICE_PORT };
  return loadEnv('admin-service', adminServiceEnvSchema, normalized);
}
