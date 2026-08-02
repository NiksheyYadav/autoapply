import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export interface CreateDatabaseOptions {
  url: string;
  maxConnections?: number;
  /** Set for one-shot processes (migrations, scripts) to avoid idle sockets. */
  singleConnection?: boolean;
  onNotice?: (notice: unknown) => void;
}

/**
 * Each service owns its own pool. Services never share a database
 * (docs/08 § Communication) — the shared piece is the schema definition, not
 * the connection.
 */
export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const sql = postgres(options.url, {
    max: options.singleConnection === true ? 1 : (options.maxConnections ?? 10),
    // Prepared statements are disabled because pgbouncer in transaction mode
    // (the deployment target) cannot support them.
    prepare: false,
    onnotice: options.onNotice ?? (() => {}),
  });

  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Liveness probe used by every service's /health endpoint. */
export async function pingDatabase(sql: postgres.Sql): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export { schema };
