import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONNECTOR_PROVIDERS } from '../src/lib/providers.js';
import { toConnectorAccountView } from '../src/lib/public-view.js';
import { createLocalSecretStore, type SecretStore } from '../src/lib/secret-store.js';

/**
 * A5 token-isolation coverage, no database (real local secret store in a temp dir).
 *
 * Gaps (not changed, src untouched):
 * - buildApp needs a real Drizzle db, so the HTTP connect/disconnect flow can
 *   only be asserted in the DB-gated connectors-flow.test.ts (self-skips
 *   without ATLAS_TEST_DATABASE_URL). Not re-tested here.
 * - SecretStore has no user concept: refs are random 24-byte capability
 *   tokens, so cross-user isolation rests on refs being unguessable and on
 *   the route never returning secret_ref, not on a store-level check.
 *   Anyone holding another user's ref could read it via get().
 * - There is no OAuth, so no token refresh or per-connector scope isolation.
 */
describe('connector credential isolation', () => {
  let root: string;
  let store: SecretStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'atlas-isolation-test-'));
    store = createLocalSecretStore({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function connectAll(prefix: string): Promise<Record<string, { ref: string; credential: string }>> {
    const out: Record<string, { ref: string; credential: string }> = {};
    for (const p of CONNECTOR_PROVIDERS) {
      const credential = `${prefix}-${p}-credential`;
      out[p] = { ref: (await store.put(credential)).ref, credential };
    }
    return out;
  }

  it('gives three providers distinct refs, each returning its own credential', async () => {
    const all = await connectAll('u1');
    expect(new Set(Object.values(all).map((v) => v.ref)).size).toBe(3);
    for (const v of Object.values(all)) expect(await store.get(v.ref)).toBe(v.credential);
  });

  it('replacing one provider secret leaves the others readable', async () => {
    const all = await connectAll('u1');
    const replacement = await store.put('new-lever-credential');
    await store.delete(all.lever!.ref); // mirrors connect.ts: swap, then retire the old secret
    await expect(store.get(all.lever!.ref)).rejects.toThrow();
    expect(await store.get(replacement.ref)).toBe('new-lever-credential');
    expect(await store.get(all.greenhouse!.ref)).toBe(all.greenhouse!.credential);
    expect(await store.get(all.ashby!.ref)).toBe(all.ashby!.credential);
  });

  it('deleting one provider secret leaves the others readable', async () => {
    const all = await connectAll('u1');
    await store.delete(all.greenhouse!.ref);
    await expect(store.get(all.greenhouse!.ref)).rejects.toThrow();
    expect(await store.get(all.lever!.ref)).toBe(all.lever!.credential);
    expect(await store.get(all.ashby!.ref)).toBe(all.ashby!.credential);
  });

  it('gives different users distinct refs even for the same provider and credential', async () => {
    const a = await store.put('shared-credential');
    const b = await store.put('shared-credential');
    expect(a.ref).not.toBe(b.ref);
    await store.delete(a.ref);
    expect(await store.get(b.ref)).toBe('shared-credential');
  });

  it('does not resolve a guessed or other-user-looking ref', async () => {
    await connectAll('u1');
    await expect(store.get('not-a-real-ref')).rejects.toThrow();
  });

  it('does not leak credential or secret_ref through the public view', async () => {
    const all = await connectAll('u1');
    const row = {
      connectorAccountId: 'ca-1',
      userId: 'user-1',
      organizationId: null,
      provider: 'lever',
      externalAccountId: 'acme',
      secretRef: all.lever!.ref,
      scopes: ['read'],
      status: 'active',
      consentGrantedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastSyncedAt: null,
      lastError: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    } as unknown as Parameters<typeof toConnectorAccountView>[0];
    const json = JSON.stringify(toConnectorAccountView(row));
    expect(json).not.toContain(all.lever!.ref);
    expect(json).not.toContain('secret');
    for (const v of Object.values(all)) expect(json).not.toContain(v.credential);
  });
});
