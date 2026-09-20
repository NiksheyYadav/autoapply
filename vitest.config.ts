import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

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
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Integration tests self-skip when ATLAS_TEST_DATABASE_URL is unset.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
