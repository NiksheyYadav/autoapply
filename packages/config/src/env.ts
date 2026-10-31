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
  MESSAGING_DRIVER: z.enum(['memory', 'rabbitmq', 'postgres']).default('memory'),
  RABBITMQ_URL: z.string().min(1).optional(),
  MESSAGING_EXCHANGE: z.string().min(1).default('atlas.events'),
  MESSAGING_MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(5),
});

export const storageEnvSchema = z.object({
  STORAGE_DRIVER: z.enum(['local', 's3', 'supabase']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().min(1).default('./.atlas-storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  /**
   * STORAGE_DRIVER=supabase: the PRIVATE bucket to keep files in, and the
   * server-side secret key (`sb_secret_…` or legacy `service_role`) used to
   * reach it. The key bypasses RLS — set it only on the services that store
   * files, as a Vercel environment variable, never in code or the repo.
   */
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default('resumes'),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
});

/**
 * Every service that verifies a caller's identity needs only the (non-secret)
 * Supabase project URL — tokens are checked against its JWKS, not a shared
 * secret. See packages/auth-kit/src/tokens.ts.
 */
export const supabaseAuthEnvSchema = z.object({
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
});

const WINDOW_UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

const RATE_LIMIT_WINDOW_MIN_MS = 1_000;
const RATE_LIMIT_WINDOW_MAX_MS = 7 * 86_400_000;

/**
 * The length in milliseconds of a rate-limit window written as `<number> <unit>` (`30 seconds`,
 * `1 minute`, `2h`), or `undefined` when the text is not that. A bare number is refused on purpose:
 * the rate-limit plugin reads `60` as 60 milliseconds, which switches limiting off in practice.
 */
export function parseRateLimitWindowMs(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(text.trim());
  if (match === null) return undefined;
  const unit = WINDOW_UNIT_MS[(match[2] ?? '').toLowerCase()];
  if (unit === undefined) return undefined;
  return Math.round(Number(match[1]) * unit);
}

/**
 * A rate-limit window such as `1 minute`. The plugin accepts any string at boot and then answers
 * every request with a 500 for text it cannot read (`abc`, `1 parsec`, empty), and a negative
 * window quietly turns limiting off, so the value is checked here, where a bad one stops the boot.
 * Between one second and seven days: below that the limit means nothing, above it a client that
 * hits the maximum is locked out for practically ever.
 */
export const rateLimitWindowSchema = z.string().refine(
  (text) => {
    const ms = parseRateLimitWindowMs(text);
    return ms !== undefined && ms >= RATE_LIMIT_WINDOW_MIN_MS && ms <= RATE_LIMIT_WINDOW_MAX_MS;
  },
  {
    message:
      'must be a number and a unit between 1 second and 7 days, for example "30 seconds", "1 minute" or "1 hour"',
  },
);

/**
 * The form of an allowed origin that a browser's `Origin` header can equal: lower-case scheme and
 * host, no path, no trailing slash. `undefined` for text that no browser would ever send, such as a
 * host without a scheme, an entry with a path, or `null`.
 */
export function normalizeCorsOrigin(entry: string): string | undefined {
  const text = entry.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined;
  }
  // A single trailing slash is the usual slip and is forgiven; any other path is not an origin.
  if (url.pathname !== '/') return undefined;
  return url.origin;
}

function splitCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * `CORS_ORIGINS`: empty, `*`, or a comma-separated list of origins. An entry that can never match
 * a browser's `Origin` header (`app.example.com`, `https://app.example.com/login`, `null`) is
 * refused at boot: it would otherwise start fine and block every browser request.
 */
export const corsOriginsSchema = z
  .string()
  .default('')
  .superRefine((value, ctx) => {
    if (value.trim() === '*') return;
    for (const entry of splitCorsOrigins(value)) {
      if (normalizeCorsOrigin(entry) === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `"${entry}" is not an origin; use scheme and host only, such as https://app.example.com`,
        });
      }
    }
  });

export const httpEnvSchema = z.object({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535),
  /** Comma-separated list, or `*` in development only. */
  CORS_ORIGINS: corsOriginsSchema,
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW: rateLimitWindowSchema.default('1 minute'),
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

/** `CORS_ORIGINS` → array of canonical origins, with `*` preserved as a wildcard sentinel. */
export function parseCorsOrigins(value: string): string[] | true {
  const trimmed = value.trim();
  if (trimmed === '*') return true;
  return splitCorsOrigins(trimmed)
    .map(normalizeCorsOrigin)
    .filter((origin): origin is string => origin !== undefined);
}
