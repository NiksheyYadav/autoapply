import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { createDatabase } from './client.js';

/** Extensions the generated DDL depends on: vector columns and gin_trgm_ops. */
const REQUIRED_EXTENSIONS = ['vector', 'pgcrypto', 'pg_trgm'] as const;

/**
 * Standalone migration runner, deployed as a Kubernetes Job that must complete
 * before the new service revision starts.
 *
 * Extensions are ensured here rather than left to the container init script so
 * this works unchanged against a managed Postgres, where no init hook exists.
 */
export async function runMigrations(databaseUrl: string): Promise<string> {
  const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
  const handle = createDatabase({ url: databaseUrl, singleConnection: true });

  try {
    for (const extension of REQUIRED_EXTENSIONS) {
      // Identifier is from a fixed const list, so interpolation is safe here;
      // CREATE EXTENSION does not accept a bind parameter for the name.
      await handle.db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS "${extension}"`));
    }
    await migrate(handle.db, { migrationsFolder });
    return migrationsFolder;
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const folder = await runMigrations(url);
  console.error(`[migrate] applied migrations from ${folder}`);
}

// Only run when invoked directly, so tests can import runMigrations.
if (process.argv[1] !== undefined && import.meta.url.endsWith('migrate.ts')) {
  const isDirectRun = process.argv[1].replace(/\\/g, '/').endsWith('src/migrate.ts');
  if (isDirectRun) {
    main().catch((error: unknown) => {
      console.error('[migrate] failed:', error);
      process.exitCode = 1;
    });
  }
}
