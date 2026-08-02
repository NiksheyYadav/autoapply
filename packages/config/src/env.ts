import { z } from 'zod';

/**
 * Config layering (docs/10 § Config layers). Every service validates its own
 * slice at boot and crashes immediately on a bad value — a half-configured
 * service that starts and then fails per-request is much harder to diagnose.
 */

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

/** Shared by every service. */
export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

export const redisEnvSchema = z.object({
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
});

export const messagingEnvSchema = z.object({
  MESSAGING_DRIVER: z.enum(['memory', 'rabbitmq']).default('memory'),
  RABBITMQ_URL: z.string().min(1).optional(),
  MESSAGING_EXCHANGE: z.string().min(1).default('atlas.events'),
  MESSAGING_MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(5),
});

export const storageEnvSchema = z.object({
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().min(1).default('./.atlas-storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
});

export const authEnvSchema = z.object({
  /**
   * 32 chars minimum. Short secrets are the single most common way a JWT
   * deployment becomes forgeable, so this is enforced rather than documented.
   */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('atlas'),
  JWT_AUDIENCE: z.string().min(1).default('atlas-clients'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .max(31_536_000)
    .default(2_592_000),
});

export const httpEnvSchema = z.object({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535),
  /** Comma-separated list, or `*` in development only. */
  CORS_ORIGINS: z.string().default(''),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
});

export class ConfigError extends Error {
  constructor(
    readonly service: string,
    readonly issues: string[],
  ) {
    super(`Invalid configuration for ${service}:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses `source` against `schema`, throwing a ConfigError that lists every
 * problem at once. Reporting only the first missing variable turns first-time
 * setup into a guessing game.
 */
export function loadEnv<T extends z.ZodType>(
  service: string,
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigError(service, issues);
  }
  return result.data as z.infer<T>;
}

/** `CORS_ORIGINS` → array, with `*` preserved as a wildcard sentinel. */
export function parseCorsOrigins(value: string): string[] | true {
  const trimmed = value.trim();
  if (trimmed === '*') return true;
  if (trimmed === '') return [];
  return trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
