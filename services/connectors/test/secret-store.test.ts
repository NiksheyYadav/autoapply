import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalSecretStore, createSecretStore, type SecretStore } from '../src/lib/secret-store.js';

describe('local secret store', () => {
  let root: string;
  let store: SecretStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'atlas-secrets-test-'));
    store = createLocalSecretStore({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a secret', async () => {
    const { ref } = await store.put('super-secret-token');
    expect(await store.get(ref)).toBe('super-secret-token');
  });

  it('gives each write a distinct ref, even for the same plaintext', async () => {
    const a = await store.put('same-value');
    const b = await store.put('same-value');
    expect(a.ref).not.toBe(b.ref);
  });

  it('makes a deleted secret unreadable', async () => {
    const { ref } = await store.put('to-be-deleted');
    await store.delete(ref);
    await expect(store.get(ref)).rejects.toThrow();
  });

  it('deleting a nonexistent ref does not throw', async () => {
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });
});

describe('createSecretStore', () => {
  it('refuses the kms driver — not implemented yet', () => {
    expect(() => createSecretStore({ driver: 'kms', localRoot: './.atlas-secrets' })).toThrow(/not implemented yet/);
  });
});
