import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const BUNDLES_E2E = 'packages/auth-kit/test/bundles-e2e.test.ts';

export default defineConfig({
  resolve: {
    alias: {
      '@atlas/types': r('./packages/types/src/index.ts'),
      '@atlas/config': r('./packages/config/src/index.ts'),
      '@atlas/utils': r('./packages/utils/src/index.ts'),
      '@atlas/db': r('./packages/db/src/index.ts'),
      '@atlas/messaging': r('./packages/messaging/src/index.ts'),
      '@atlas/storage': r('./packages/storage/src/index.ts'),
      '@atlas/auth-kit': r('./packages/auth-kit/src/index.ts'),
      '@atlas/ai': r('./packages/ai/src/index.ts'),
      '@atlas/observability': r('./packages/observability/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    // Integration tests self-skip when ATLAS_TEST_DATABASE_URL is unset.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'suites',
          include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', BUNDLES_E2E],
        },
      },
      {
        // Boots the committed deploy bundles and calls their real /drain routes, which consume the
        // shared test database's outbox and score every user's parsed resume against the job it
        // ingests. Run alongside the other DB suites, that handed an unrelated job to a seeded
        // user and broke exact-set assertions in their tests (account export). It therefore runs
        // in its own group, strictly after everything else has finished.
        extends: true,
        test: {
          name: 'deploy-bundles',
          include: [BUNDLES_E2E],
          exclude: ['**/node_modules/**', '**/dist/**'],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
