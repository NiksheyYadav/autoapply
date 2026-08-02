import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

function readGeneratedSql(): string {
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'));
  expect(files.length).toBeGreaterThan(0);
  return files.map((file) => readFileSync(`${migrationsDir}/${file}`, 'utf8')).join('\n');
}

/**
 * Every exported table, ignoring enums, relations, and constants. The values
 * are widened to `unknown` first because the export union is too specific for
 * a type predicate to narrow directly.
 */
const tables: PgTable[] = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable),
);

describe('schema definition', () => {
  it('declares every table from docs/02', () => {
    const names = tables.map((table) => getTableConfig(table).name).sort();
    for (const required of [
      'users',
      'organizations',
      'organization_members',
      'students',
      'resumes',
      'jobs',
      'companies',
      'applications',
      'contacts',
      'messages',
      'tasks',
      'analytics_events',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('gives every table a primary key or a composite primary key', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const hasColumnPk = config.columns.some((column) => column.primary);
      const hasCompositePk = config.primaryKeys.length > 0;
      expect(
        hasColumnPk || hasCompositePk,
        `table ${config.name} has no primary key`,
      ).toBe(true);
    }
  });

  it('never stores a raw credential column', () => {
    // docs/09: tokens live in the secret store; only references belong in Postgres.
    const forbidden = ['access_token', 'refresh_token', 'oauth_token', 'client_secret'];
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        expect(
          forbidden,
          `${config.name}.${column.name} looks like a raw credential`,
        ).not.toContain(column.name);
      }
    }
  });
});

describe('generated migration', () => {
  const sqlText = readGeneratedSql();

  it('enforces the dedupe constraints called for in docs/02', () => {
    expect(sqlText).toContain('CREATE UNIQUE INDEX "jobs_job_hash_key"');
    expect(sqlText).toContain('CREATE UNIQUE INDEX "jobs_source_external_id_key"');
    expect(sqlText).toContain('CREATE UNIQUE INDEX "connector_accounts_provider_external_key"');
    expect(sqlText).toContain('CREATE UNIQUE INDEX "companies_normalized_name_key"');
  });

  it('makes email uniqueness case-insensitive', () => {
    expect(sqlText).toContain('CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"))');
  });

  it('enforces idempotency on the two endpoints that require it', () => {
    // docs/04: application submission and outreach sending.
    expect(sqlText).toContain('CREATE UNIQUE INDEX "applications_user_idempotency_key"');
    expect(sqlText).toContain('CREATE UNIQUE INDEX "messages_user_idempotency_key"');
  });

  it('creates vector columns for resume, job, and contact embeddings', () => {
    expect(sqlText).toMatch(/"embedding" vector\(1536\)/);
    const vectorColumns = sqlText.match(/"embedding" vector\(1536\)/g) ?? [];
    expect(vectorColumns.length).toBeGreaterThanOrEqual(3);
  });

  it('cascades deletes from users so data-deletion requests are satisfiable', () => {
    // docs/09 § Compliance posture: support data export and deletion workflows.
    expect(sqlText).toMatch(/"resumes_user_id_users_user_id_fk"[\s\S]{0,200}ON DELETE cascade/);
    expect(sqlText).toMatch(/"sessions_user_id_users_user_id_fk"[\s\S]{0,200}ON DELETE cascade/);
  });
});
