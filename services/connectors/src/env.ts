import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv } from '@atlas/config';
import { z } from 'zod';

export const connectorsServiceEnvSchema = z
  .object({
    ...baseEnvSchema.shape,
    ...databaseEnvSchema.shape,
    ...httpEnvSchema.shape,
    /** Verifies auth-service's JWTs; must match its JWT_SECRET/ISSUER/AUDIENCE. */
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().min(1).default('atlas'),
    JWT_AUDIENCE: z.string().min(1).default('atlas-clients'),
    /**
     * `local` writes credentials to plain files under SECRET_STORE_LOCAL_ROOT —
     * fine for exercising this service in dev, never acceptable in production.
     * `kms` (docs/09 § Token handling: "Encrypt OAuth tokens with KMS-backed
     * envelope encryption") is not implemented yet and throws at factory time,
     * mirroring @atlas/storage's `s3` driver. The refine below turns "forgot
     * to set this in prod" into a boot-time crash instead of a silent
     * plaintext-secrets deployment.
     */
    SECRET_STORE_DRIVER: z.enum(['local', 'kms']).default('local'),
    SECRET_STORE_LOCAL_ROOT: z.string().min(1).default('./.atlas-secrets'),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.SECRET_STORE_DRIVER === 'local'), {
    message: 'SECRET_STORE_DRIVER=local writes plaintext secrets to disk and is not allowed when NODE_ENV=production',
    path: ['SECRET_STORE_DRIVER'],
  });

export type ConnectorsServiceEnv = z.infer<typeof connectorsServiceEnvSchema>;

export function loadConnectorsServiceEnv(
  source: Record<string, string | undefined> = process.env,
): ConnectorsServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.CONNECTORS_SERVICE_PORT };
  return loadEnv('connectors-service', connectorsServiceEnvSchema, normalized);
}
