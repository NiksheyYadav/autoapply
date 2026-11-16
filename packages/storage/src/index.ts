import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDriver } from './local-driver.js';
import { createSupabaseDriver } from './supabase-driver.js';
import type { StorageDriver } from './driver.js';

export * from './driver.js';
export * from './local-driver.js';
export * from './supabase-driver.js';

export interface CreateStorageOptions {
  driver: 'local' | 's3' | 'supabase';
  localRoot?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  supabaseUrl?: string;
  supabaseSecretKey?: string;
  supabaseBucket?: string;
}

export function createStorage(options: CreateStorageOptions): StorageDriver {
  if (options.driver === 'local') {
    return createLocalDriver({ root: options.localRoot ?? './.atlas-storage' });
  }
  if (options.driver === 'supabase') {
    if (!options.supabaseUrl || !options.supabaseSecretKey || !options.supabaseBucket) {
      throw new Error(
        "Storage driver 'supabase' needs SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_STORAGE_BUCKET.",
      );
    }
    return createSupabaseDriver({
      url: options.supabaseUrl,
      secretKey: options.supabaseSecretKey,
      bucket: options.supabaseBucket,
    });
  }
  // Never selected by current config — deferred until something actually
  // exercises S3 storage, rather than shipping an untested AWS SDK integration.
  throw new Error("Storage driver 's3' is not implemented yet — set STORAGE_DRIVER=supabase (or local for development).");
}

/** The slice of a service's validated env that picks and configures a storage driver. */
export interface StorageEnv {
  STORAGE_DRIVER: 'local' | 's3' | 'supabase';
  STORAGE_LOCAL_ROOT: string;
  S3_BUCKET?: string | undefined;
  S3_REGION?: string | undefined;
  S3_ENDPOINT?: string | undefined;
  SUPABASE_URL?: string | undefined;
  SUPABASE_SECRET_KEY?: string | undefined;
  SUPABASE_STORAGE_BUCKET?: string | undefined;
}

export interface StorageOptionsResult {
  options: CreateStorageOptions;
  /** Set when the chosen configuration cannot keep files, so the caller can log it. */
  warning?: string;
}

/**
 * Maps env to `createStorage` options. On a serverless runtime (`VERCEL`)
 * the project directory is read-only, so a `local` driver pointed there would
 * make every upload fail: it is redirected to the writable (but ephemeral)
 * temp dir, and a warning says so. That keeps parsing and the rest of the API
 * working until a durable driver is configured; it is not durable storage.
 */
export function storageOptionsFromEnv(
  env: StorageEnv,
  runtime: { serverless?: boolean } = {},
): StorageOptionsResult {
  if (env.STORAGE_DRIVER === 'supabase') {
    return {
      options: {
        driver: 'supabase',
        supabaseUrl: env.SUPABASE_URL,
        supabaseSecretKey: env.SUPABASE_SECRET_KEY,
        supabaseBucket: env.SUPABASE_STORAGE_BUCKET,
      },
    };
  }
  if (env.STORAGE_DRIVER === 'local' && runtime.serverless) {
    return {
      options: { driver: 'local', localRoot: join(tmpdir(), 'atlas-storage') },
      warning:
        'STORAGE_DRIVER=local on a serverless runtime: uploaded files are kept in ephemeral temp storage and will be lost. Set STORAGE_DRIVER=supabase for durable storage.',
    };
  }
  return {
    options: {
      driver: env.STORAGE_DRIVER,
      localRoot: env.STORAGE_LOCAL_ROOT,
      s3Bucket: env.S3_BUCKET,
      s3Region: env.S3_REGION,
      s3Endpoint: env.S3_ENDPOINT,
    },
  };
}
