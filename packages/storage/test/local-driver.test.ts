import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDriver } from '../src/local-driver.js';
import { createStorage } from '../src/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-storage-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('local storage driver', () => {
  it('round-trips a put through get', async () => {
    const driver = createLocalDriver({ root });
    const data = Buffer.from('hello resume');
    const result = await driver.put('resumes/one.txt', data);
    expect(result).toEqual({ key: 'resumes/one.txt', byteSize: data.length });
    await expect(driver.get('resumes/one.txt')).resolves.toEqual(data);
  });

  it('reports existence correctly before and after a put', async () => {
    const driver = createLocalDriver({ root });
    await expect(driver.exists('missing.bin')).resolves.toBe(false);
    await driver.put('present.bin', Buffer.from('x'));
    await expect(driver.exists('present.bin')).resolves.toBe(true);
  });

  it('deletes an object, and deleting a missing one is a no-op', async () => {
    const driver = createLocalDriver({ root });
    await driver.put('to-delete.bin', Buffer.from('x'));
    await driver.delete('to-delete.bin');
    await expect(driver.exists('to-delete.bin')).resolves.toBe(false);
    await expect(driver.delete('never-existed.bin')).resolves.toBeUndefined();
  });

  it('throws NOT_FOUND when getting a missing key', async () => {
    const driver = createLocalDriver({ root });
    await expect(driver.get('nope.bin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a key that tries to escape the root', async () => {
    const driver = createLocalDriver({ root });
    await expect(driver.put('../escape.bin', Buffer.from('x'))).rejects.toThrow();
    await expect(driver.get('../../etc/passwd')).rejects.toThrow();
  });

  it('creates nested directories on demand', async () => {
    const driver = createLocalDriver({ root });
    await driver.put('a/b/c/deep.bin', Buffer.from('nested'));
    await expect(driver.exists('a/b/c/deep.bin')).resolves.toBe(true);
  });
});

describe('createStorage factory', () => {
  it('builds a working local driver', async () => {
    const storage = createStorage({ driver: 'local', localRoot: root });
    await storage.put('x.bin', Buffer.from('y'));
    await expect(storage.exists('x.bin')).resolves.toBe(true);
  });

  it('refuses the s3 driver for now', () => {
    expect(() => createStorage({ driver: 's3' })).toThrow(/not implemented/);
  });
});
