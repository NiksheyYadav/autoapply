import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { AppError } from '@atlas/utils';
import type { PutOptions, PutResult, StorageDriver } from './driver.js';

export interface LocalDriverOptions {
  root: string;
}

/** Resolves `key` under `root`, rejecting anything that would escape it (`../`, absolute paths, NUL bytes). */
function resolveKeyPath(root: string, key: string): string {
  if (!key || key.includes('\0')) {
    throw new AppError('VALIDATION_ERROR', `Invalid storage key: "${key}"`);
  }
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, key);
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new AppError('VALIDATION_ERROR', `Storage key escapes root: "${key}"`);
  }
  return target;
}

export function createLocalDriver(options: LocalDriverOptions): StorageDriver {
  const root = options.root;

  return {
    async put(key: string, data: Buffer, _options?: PutOptions): Promise<PutResult> {
      const target = resolveKeyPath(root, key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
      return { key, byteSize: data.length };
    },

    async get(key: string): Promise<Buffer> {
      const target = resolveKeyPath(root, key);
      try {
        return await readFile(target);
      } catch (cause) {
        if ((cause as { code?: string }).code === 'ENOENT') {
          throw new AppError('NOT_FOUND', `No stored object for key "${key}"`, { cause });
        }
        throw cause;
      }
    },

    async delete(key: string): Promise<void> {
      const target = resolveKeyPath(root, key);
      await rm(target, { force: true });
    },

    async exists(key: string): Promise<boolean> {
      const target = resolveKeyPath(root, key);
      try {
        await stat(target);
        return true;
      } catch (cause) {
        if ((cause as { code?: string }).code === 'ENOENT') return false;
        throw cause;
      }
    },
  };
}
