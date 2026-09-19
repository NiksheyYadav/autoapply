export interface PutOptions {
  contentType?: string;
}

export interface PutResult {
  key: string;
  byteSize: number;
}

/**
 * Every caller — profile-service today, whatever needs file storage next —
 * goes through this interface rather than a concrete driver, so swapping
 * `local` for `s3` later is a one-file change (docs/10 § storage themes).
 */
export interface StorageDriver {
  put(key: string, data: Buffer, options?: PutOptions): Promise<PutResult>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
