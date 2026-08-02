import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas',
  },
  // Extensions are created by the container init script, not by migrations,
  // so drizzle-kit must not try to manage them.
  extensionsFilters: ['postgres_vector'],
  verbose: true,
  strict: true,
});
