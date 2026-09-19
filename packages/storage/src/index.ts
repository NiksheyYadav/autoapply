import { createLocalDriver } from './local-driver.js';
import type { StorageDriver } from './driver.js';

export * from './driver.js';
export * from './local-driver.js';

export interface CreateStorageOptions {
  driver: 'local' | 's3';
  localRoot?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
}

export function createStorage(options: CreateStorageOptions): StorageDriver {
  if (options.driver === 'local') {
    return createLocalDriver({ root: options.localRoot ?? './.atlas-storage' });
  }
  // Never selected by current config (STORAGE_DRIVER defaults to 'local' everywhere,
  // .env.example included) — deferred until something actually exercises S3 storage,
  // rather than shipping an untested AWS SDK integration nothing calls yet.
  throw new Error("Storage driver 's3' is not implemented yet — set STORAGE_DRIVER=local.");
}
