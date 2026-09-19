import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const jobsServiceEnvSchema = z.object({
  ...baseEnvSchema.shape,
  ...databaseEnvSchema.shape,
  ...httpEnvSchema.shape,
  ...messagingEnvSchema.shape,
  /** Verifies auth-service's JWTs; must match its JWT_SECRET/ISSUER/AUDIENCE. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('atlas'),
  JWT_AUDIENCE: z.string().min(1).default('atlas-clients'),
});

export type JobsServiceEnv = z.infer<typeof jobsServiceEnvSchema>;

export function loadJobsServiceEnv(source: Record<string, string | undefined> = process.env): JobsServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.JOBS_SERVICE_PORT };
  return loadEnv('jobs-service', jobsServiceEnvSchema, normalized);
}
