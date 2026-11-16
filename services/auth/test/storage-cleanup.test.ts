import { describe, expect, it } from 'vitest';
import type { StorageDriver } from '@atlas/storage';
import { AppError } from '@atlas/utils';
import { removeStoredFiles } from '../src/lib/storage-cleanup.js';

function driver(onDelete: (key: string) => Promise<void>): StorageDriver {
  return {
    put: async () => {
      throw new Error('not used');
    },
    get: async () => {
      throw new Error('not used');
    },
    exists: async () => false,
    delete: onDelete,
  };
}

describe('removeStoredFiles', () => {
  it('deletes every key and reports a clean count', async () => {
    const deleted: string[] = [];
    const result = await removeStoredFiles(
      driver(async (key) => {
        deleted.push(key);
      }),
      ['resumes/u/1', 'resumes/u/2', 'resumes/u/3'],
    );

    expect(deleted.sort()).toEqual(['resumes/u/1', 'resumes/u/2', 'resumes/u/3']);
    expect(result).toEqual({ total: 3, failed: 0, failureKinds: [] });
  });

  it('does nothing, and calls nothing, when there are no files', async () => {
    const result = await removeStoredFiles(
      driver(async () => {
        throw new Error('should not be called');
      }),
      [],
    );
    expect(result).toEqual({ total: 0, failed: 0, failureKinds: [] });
  });

  it('keeps going past failures, counts them, and reports error classes only (never messages or keys)', async () => {
    const result = await removeStoredFiles(
      driver(async (key) => {
        if (key.endsWith('/1')) throw new AppError('UPSTREAM_UNAVAILABLE', 'File storage is temporarily unavailable');
        if (key.endsWith('/2')) throw new Error('boom: jane.doe@example.com uploaded resume-jane.pdf');
      }),
      ['resumes/u/1', 'resumes/u/2', 'resumes/u/3'],
    );

    expect(result.total).toBe(3);
    expect(result.failed).toBe(2);
    expect(result.failureKinds).toEqual(['Error', 'UPSTREAM_UNAVAILABLE']);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('jane.doe');
    expect(serialized).not.toContain('resume-jane');
    expect(serialized).not.toContain('resumes/u');
  });

  it('gives up on a call that hangs, counts it as failed and does not hold the response hostage', async () => {
    const started = Date.now();
    const result = await removeStoredFiles(
      driver((key) => (key.endsWith('/hang') ? new Promise<void>(() => {}) : Promise.resolve())),
      ['resumes/u/ok', 'resumes/u/hang'],
      50,
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({ total: 2, failed: 1, failureKinds: ['TIMEOUT'] });
  });

  it('turns a driver that throws synchronously into a counted failure too', async () => {
    const throwing: StorageDriver = {
      ...driver(async () => {}),
      delete: () => {
        throw new TypeError('sync failure');
      },
    };

    const result = await removeStoredFiles(throwing, ['resumes/u/1']);

    expect(result).toEqual({ total: 1, failed: 1, failureKinds: ['TypeError'] });
  });
});
