import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';

// packages/db/supabase/rls.sql: Row Level Security on every public table and no
// privileges for anon/authenticated, so the publishable key cannot read anything
// through Supabase's Data API (/rest/v1). Real RLS behaviour needs a real
// Postgres, so this is DB-backed and self-skips without ATLAS_TEST_DATABASE_URL.
//
// It never touches the database that URL points at. It uses that connection
// (which must be a superuser, like the rest of the DB-backed setup) only to
// CREATE and DROP scratch databases named rls_probe_<random>, so it can run next to
// the other suites without disturbing them. In each scratch database it replays
// the repo's recipe: supabase-stub.sql, migrations, auth-hooks.sql, then rls.sql.
const adminUrl = process.env.ATLAS_TEST_DATABASE_URL;

const readRepoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const LOCKED_ROLES = ['anon', 'authenticated'] as const;
const noop = (): void => {};

/**
 * What a fresh Supabase project does before any of our SQL runs: schema USAGE plus
 * default privileges granting ALL on future tables, sequences and functions in
 * `public` to anon and authenticated. infra/ci/supabase-stub.sql does not model
 * this, and without it every "denied" assertion below would hold even if rls.sql
 * did nothing. Applied before the migrations, so every table inherits the grants
 * exactly as it does on Supabase.
 */
const SUPABASE_DEFAULT_GRANTS = `
  GRANT USAGE ON SCHEMA public TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
`;

/**
 * GoTrue owns the auth schema on Supabase and inserts into auth.users as
 * supabase_auth_admin. The stub's roles own nothing, so give that role what its
 * real counterpart has, to exercise the real signup path (non-owner insert,
 * trigger running a SECURITY DEFINER function).
 */
const AUTH_ADMIN_GRANTS = `
  GRANT USAGE ON SCHEMA auth TO supabase_auth_admin;
  GRANT INSERT ON auth.users TO supabase_auth_admin;
`;

type ProbeResult =
  | { ok: true; rows: Record<string, unknown>[]; count: number }
  | { ok: false; code: string; message: string };

/** Thrown to roll a transaction back while still returning a value from it. */
class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super('rollback');
  }
}

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function pgCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}

function replaceOnce(text: string, from: string, to: string): string {
  const first = text.indexOf(from);
  if (first === -1 || text.indexOf(from, first + 1) !== -1) {
    throw new Error(`rls.sql no longer contains exactly one "${from}"; update this test`);
  }
  return text.replace(from, () => to);
}

/** A missing-privilege failure, as opposed to an RLS policy violation (also SQLSTATE 42501). */
function isPermissionDenied(result: ProbeResult): boolean {
  return (
    !result.ok &&
    result.code === '42501' &&
    /permission denied/i.test(result.message) &&
    !/row-level security/i.test(result.message)
  );
}

describe.skipIf(!adminUrl)('rls.sql (Data API lockdown of schema public)', () => {
  const scratchDatabases: string[] = [];
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let rlsSql: string;
  let baselineExposed: { anon: boolean; authenticated: boolean };
  let seededUserId: string;
  let publicTables: string[];

  async function createScratchDatabase(): Promise<string> {
    const name = `rls_probe_${randomBytes(5).toString('hex')}`;
    // Concurrent CREATE DATABASE runs on a shared cluster can collide on the template.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`);
        scratchDatabases.push(name);
        return name;
      } catch (error) {
        if (pgCode(error) !== '55006' || attempt >= 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }

  /** Run `fn` in a transaction that is always rolled back; resolves with fn's value. */
  async function inRolledBackTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    try {
      await sql.begin(async (tx) => {
        throw new Rollback(await fn(tx));
      });
    } catch (error) {
      if (error instanceof Rollback) return error.value as T;
      throw error;
    }
    throw new Error('unreachable');
  }

  /** Run one statement as `role` (SET LOCAL ROLE) and report success or the Postgres error. Never persists. */
  async function probe(role: string, statement: string): Promise<ProbeResult> {
    try {
      return await inRolledBackTx(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        const rows = await tx.unsafe(statement);
        return {
          ok: true as const,
          rows: [...rows] as Record<string, unknown>[],
          count: rows.count,
        };
      });
    } catch (error) {
      return {
        ok: false,
        code: pgCode(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Everything rls.sql is supposed to settle: ACLs, RLS flags, defaults, policies, event trigger. */
  async function fingerprint(): Promise<string> {
    const rows = await sql.unsafe<{ line: string }[]>(`
      SELECT concat_ws('|', 'rel', c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, coalesce(c.relacl::text, '-')) AS line
        FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      UNION ALL
      SELECT concat_ws('|', 'proc', p.oid::regprocedure, coalesce(p.proacl::text, '-'))
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      UNION ALL
      SELECT concat_ws('|', 'defacl', pg_get_userbyid(defaclrole), defaclnamespace::regnamespace, defaclobjtype, defaclacl::text)
        FROM pg_default_acl
      UNION ALL
      SELECT concat_ws('|', 'policy', polname, polrelid::regclass, polcmd, polroles::regrole[]::text)
        FROM pg_policy
      UNION ALL
      SELECT concat_ws('|', 'evt', evtname, evtevent, evtenabled)
        FROM pg_event_trigger
      ORDER BY 1`);
    return rows.map((row) => row.line).join('\n');
  }

  beforeAll(async () => {
    admin = postgres(adminUrl as string, { max: 1, prepare: false, onnotice: noop });
    const [self] = await admin<{ rolsuper: boolean }[]>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
    if (self?.rolsuper !== true) {
      throw new Error(
        'rls.test.ts needs ATLAS_TEST_DATABASE_URL to be a superuser connection (it creates scratch databases and SET ROLEs); see scripts/ci/setup-test-db.sh',
      );
    }

    rlsSql = readRepoFile('../supabase/rls.sql');
    const dbName = await createScratchDatabase();
    const dbUrl = urlFor(adminUrl as string, dbName);
    // One connection: the stub script issues its own BEGIN/COMMIT, which postgres.js only allows then.
    sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: noop });

    // The repo's recipe (scripts/ci/setup-test-db.sh), with Supabase's default grants in place first.
    await sql.unsafe(readRepoFile('../../../infra/ci/supabase-stub.sql'));
    await sql.unsafe(SUPABASE_DEFAULT_GRANTS);
    await runMigrations(dbUrl);
    await sql.unsafe(readRepoFile('../supabase/auth-hooks.sql'));
    await sql.unsafe(AUTH_ADMIN_GRANTS);

    // One real user + organization + owner membership, created through the same trigger production uses.
    seededUserId = randomUUID();
    await sql`
      INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      VALUES (${seededUserId}, ${`rls-seed-${seededUserId}@example.com`}, now(),
              '{"provider":"email"}'::jsonb, '{"organization_name":"RLS Probe Org"}'::jsonb, now(), now())`;

    // Before hardening, the baseline must really leak, or the later assertions prove nothing.
    const exposed = async (role: string): Promise<boolean> => {
      const result = await probe(role, 'SELECT user_id FROM public.users');
      return result.ok && result.count > 0;
    };
    baselineExposed = {
      anon: await exposed('anon'),
      authenticated: await exposed('authenticated'),
    };

    await sql.unsafe(rlsSql);

    publicTables = (
      await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
    ).map((row) => row.table_name);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(noop);
    for (const name of scratchDatabases) {
      await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(noop);
    }
    await admin?.end({ timeout: 5 }).catch(noop);
  }, 60_000);

  it('precondition: with Supabase default grants and no RLS, the anon key could read real rows', () => {
    expect(baselineExposed).toEqual({ anon: true, authenticated: true });
  });

  it('enables RLS (never FORCE) on every table in public, including all the sensitive ones', async () => {
    for (const required of [
      'resumes',
      'messages',
      'contacts',
      'connector_accounts',
      'users',
      'organization_members',
    ]) {
      expect(publicTables).toContain(required);
    }
    expect(publicTables.length).toBeGreaterThanOrEqual(18);

    const rows = await sql<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname::text, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') ORDER BY relname`;
    expect(rows.filter((row) => !row.relrowsecurity).map((row) => row.relname)).toEqual([]);
    expect(rows.filter((row) => row.relforcerowsecurity).map((row) => row.relname)).toEqual([]);
  });

  it('denies anon and authenticated every operation on every table in public', async () => {
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT DISTINCT ON (table_name) table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`;
    const firstColumn = new Map(columns.map((row) => [row.table_name, row.column_name]));

    const failures: string[] = [];
    for (const role of LOCKED_ROLES) {
      for (const table of publicTables) {
        const column = firstColumn.get(table);
        const operations: Record<string, string> = {
          SELECT: `SELECT * FROM public."${table}" LIMIT 1`,
          INSERT: `INSERT INTO public."${table}" DEFAULT VALUES`,
          UPDATE: `UPDATE public."${table}" SET "${column}" = "${column}"`,
          DELETE: `DELETE FROM public."${table}"`,
          TRUNCATE: `TRUNCATE public."${table}"`,
        };
        for (const [operation, statement] of Object.entries(operations)) {
          const result = await probe(role, statement);
          if (!isPermissionDenied(result)) {
            failures.push(
              `${role} ${operation} ${table}: ${result.ok ? 'was allowed' : `${result.code} ${result.message}`}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('leaves anon, authenticated and PUBLIC no privilege on any table, view, sequence or function in public', async () => {
    const leaks = await sql<{ line: string }[]>`
      SELECT format('%s can access table %s', r.rolname, c.relname) AS line
        FROM pg_roles r, pg_class c
       WHERE r.rolname IN ('anon', 'authenticated')
         AND c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND (has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
              OR has_table_privilege(r.oid, c.oid, 'DELETE,TRUNCATE,TRIGGER'))
      UNION ALL
      SELECT format('%s can use sequence %s', r.rolname, c.relname)
        FROM pg_roles r, pg_class c
       WHERE r.rolname IN ('anon', 'authenticated')
         AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
         AND has_sequence_privilege(r.oid, c.oid, 'USAGE,SELECT,UPDATE')
      UNION ALL
      SELECT format('%s can execute %s', r.rolname, p.oid::regprocedure)
        FROM pg_roles r, pg_proc p
       WHERE r.rolname IN ('anon', 'authenticated')
         AND p.pronamespace = 'public'::regnamespace AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
      UNION ALL
      SELECT format('PUBLIC can execute %s', p.oid::regprocedure)
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))
      UNION ALL
      SELECT format('policy %s on %s applies to anon/authenticated/PUBLIC', p.polname, p.polrelid::regclass)
        FROM pg_policy p
       WHERE p.polroles = '{0}'::oid[]
          OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid = ANY (p.polroles) AND r.rolname IN ('anon', 'authenticated'))`;
    expect(leaks.map((row) => row.line)).toEqual([]);

    // And the two Atlas functions, called rather than just inspected.
    for (const role of LOCKED_ROLES) {
      expect(
        isPermissionDenied(
          await probe(role, `SELECT public.custom_access_token_hook('{}'::jsonb)`),
        ),
      ).toBe(true);
    }
  });

  it('is idempotent: applying it again changes nothing', async () => {
    const before = await fingerprint();
    expect(before).toContain('evt|atlas_enable_rls_on_new_tables');
    await sql.unsafe(rlsSql);
    await sql.unsafe(rlsSql);
    expect(await fingerprint()).toBe(before);
  });

  it('keeps the privileged owner working: reads, writes and signup', async () => {
    // The connection used by tests (a superuser) bypasses everything, so also prove it
    // for a plain table owner with no BYPASSRLS, which is what ENABLE (not FORCE) is for.
    for (const table of publicTables) {
      const [row] = await sql.unsafe<{ n: string }[]>(
        `SELECT count(*) AS n FROM public."${table}"`,
      );
      expect(Number(row?.n)).toBeGreaterThanOrEqual(0);
    }
    const ownerRole = `rls_probe_owner_${randomBytes(4).toString('hex')}`;
    const ownerView = await inRolledBackTx(async (tx) => {
      await tx.unsafe(`CREATE ROLE ${ownerRole} NOLOGIN`);
      await tx.unsafe(`ALTER TABLE public.users OWNER TO ${ownerRole}`);
      await tx.unsafe(`SET LOCAL ROLE ${ownerRole}`);
      const visible = await tx.unsafe('SELECT user_id FROM public.users');
      const updated = await tx.unsafe('UPDATE public.users SET full_name = full_name');
      return { visible: visible.length, updated: updated.count };
    });
    expect(ownerView.visible).toBeGreaterThan(0);
    expect(ownerView.updated).toBeGreaterThan(0);

    // Signup as GoTrue does it: a non-owner inserts into auth.users and the trigger
    // creates the app rows through a SECURITY DEFINER function it has no EXECUTE on.
    const newUserId = randomUUID();
    const created = await inRolledBackTx(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE supabase_auth_admin');
      await tx.unsafe(
        `INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         VALUES ('${newUserId}', 'rls-signup-${newUserId}@example.com', now(), '{"provider":"email"}'::jsonb,
                 '{"organization_name":"Signup Org"}'::jsonb, now(), now())`,
      );
      await tx.unsafe('RESET ROLE');
      const users = await tx.unsafe(`SELECT 1 FROM public.users WHERE user_id = '${newUserId}'`);
      const members = await tx.unsafe(
        `SELECT role FROM public.organization_members WHERE user_id = '${newUserId}'`,
      );
      return { users: users.length, memberRoles: members.map((row) => row['role']) };
    });
    expect(created).toEqual({ users: 1, memberRoles: ['owner'] });
  });

  it('keeps what Supabase Auth needs: schema usage, the hook, and reading organization_members', async () => {
    const [grants] = await sql<{ usage: boolean; execute: boolean; select: boolean }[]>`
      SELECT has_schema_privilege('supabase_auth_admin', 'public', 'USAGE') AS usage,
             has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'EXECUTE') AS execute,
             has_table_privilege('supabase_auth_admin', 'public.organization_members', 'SELECT') AS "select"`;
    expect(grants).toEqual({ usage: true, execute: true, select: true });

    // Behaviour, not just grants: RLS is on, yet the role still sees the rows and the hook still works.
    const [owned] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM public.organization_members`;
    const members = await probe('supabase_auth_admin', 'SELECT * FROM public.organization_members');
    expect(members.ok && members.count).toBe(owned?.n);
    expect(owned?.n).toBeGreaterThan(0);

    const hook = await probe(
      'supabase_auth_admin',
      `SELECT public.custom_access_token_hook(
         jsonb_build_object('user_id', '${seededUserId}', 'claims', '{"app_metadata": {}}'::jsonb)
       ) AS event`,
    );
    expect(hook.ok).toBe(true);
    const event = hook.ok
      ? (hook.rows[0]?.['event'] as { claims: { app_metadata: Record<string, unknown> } })
      : null;
    expect(event?.claims.app_metadata['role']).toBe('owner');
    expect(typeof event?.claims.app_metadata['org_id']).toBe('string');

    // Least privilege: it never had, and still does not have, access to the rest.
    expect(
      isPermissionDenied(await probe('supabase_auth_admin', 'SELECT * FROM public.resumes')),
    ).toBe(true);
  });

  it('keeps tables, views, sequences and functions created later out of reach (default privileges)', async () => {
    await sql.unsafe(`
      CREATE TABLE public.rls_probe_late (id serial PRIMARY KEY, secret text);
      INSERT INTO public.rls_probe_late (secret) VALUES ('top secret');
      CREATE VIEW public.rls_probe_late_view AS SELECT * FROM public.rls_probe_late;
      CREATE SEQUENCE public.rls_probe_late_seq;
      CREATE FUNCTION public.rls_probe_late_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';`);
    try {
      const [flags] = await sql<{ rls: boolean }[]>`
        SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.rls_probe_late'::regclass`;
      expect(flags?.rls).toBe(true);

      for (const role of LOCKED_ROLES) {
        for (const statement of [
          'SELECT * FROM public.rls_probe_late',
          'INSERT INTO public.rls_probe_late DEFAULT VALUES',
          'SELECT * FROM public.rls_probe_late_view',
          `SELECT nextval('public.rls_probe_late_seq')`,
          'SELECT public.rls_probe_late_fn()',
        ]) {
          const result = await probe(role, statement);
          expect(isPermissionDenied(result), `${role}: ${statement}`).toBe(true);
        }
      }
    } finally {
      await sql.unsafe(`
        DROP VIEW IF EXISTS public.rls_probe_late_view;
        DROP TABLE IF EXISTS public.rls_probe_late;
        DROP SEQUENCE IF EXISTS public.rls_probe_late_seq;
        DROP FUNCTION IF EXISTS public.rls_probe_late_fn();`);
    }
  });

  it('is deny-all through RLS alone, even if a grant sneaks back in', async () => {
    const view = await inRolledBackTx(async (tx) => {
      await tx.unsafe('GRANT ALL ON public.users TO anon, authenticated');
      const results: Record<string, { rows: number; updated: number; insertError: string }> = {};
      for (const role of LOCKED_ROLES) {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        const rows = await tx.unsafe('SELECT user_id FROM public.users');
        const updated = await tx.unsafe('UPDATE public.users SET full_name = full_name');
        await tx.unsafe('SAVEPOINT s');
        let insertError = '';
        try {
          await tx.unsafe('INSERT INTO public.users DEFAULT VALUES');
        } catch (error) {
          insertError = `${pgCode(error)} ${error instanceof Error ? error.message : ''}`;
        }
        await tx.unsafe('ROLLBACK TO SAVEPOINT s');
        results[role] = { rows: rows.length, updated: updated.count, insertError };
        await tx.unsafe('RESET ROLE');
      }
      return results;
    });
    for (const role of LOCKED_ROLES) {
      expect(view[role]?.rows, `${role} rows`).toBe(0);
      expect(view[role]?.updated, `${role} updated`).toBe(0);
      expect(view[role]?.insertError, `${role} insert`).toMatch(/^42501 .*row-level security/);
    }
  });

  it('heals drift: re-applying revokes a grant that crept back in', async () => {
    await sql.unsafe('GRANT SELECT ON public.messages TO anon');
    expect((await probe('anon', 'SELECT * FROM public.messages')).ok).toBe(true); // grant works, RLS hides rows
    await sql.unsafe(rlsSql);
    expect(isPermissionDenied(await probe('anon', 'SELECT * FROM public.messages'))).toBe(true);
  });

  it('lets a table be exposed deliberately via v_data_api_objects, and nothing else', async () => {
    const allowlisted = replaceOnce(
      rlsSql,
      'v_data_api_objects constant text[] := ARRAY[]::text[];',
      `v_data_api_objects constant text[] := ARRAY['messages']::text[];`,
    );
    await sql.unsafe('GRANT SELECT ON public.messages TO authenticated');
    try {
      await sql.unsafe(allowlisted);
      const kept = await probe('authenticated', 'SELECT * FROM public.messages');
      expect(kept.ok && kept.count).toBe(0); // reachable, but RLS with no policy still returns nothing
      expect(
        isPermissionDenied(await probe('authenticated', 'SELECT * FROM public.contacts')),
      ).toBe(true);
      const [flags] = await sql<{ rls: boolean }[]>`
        SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.messages'::regclass`;
      expect(flags?.rls).toBe(true);
    } finally {
      await sql.unsafe(rlsSql); // the real file takes the grant away again
    }
    expect(isPermissionDenied(await probe('authenticated', 'SELECT * FROM public.messages'))).toBe(
      true,
    );
  });

  it('refuses to commit, and changes nothing, if Supabase Auth would lose its grants', async () => {
    await sql.unsafe(`
      CREATE TABLE public.rls_probe_atomic (id int);
      ALTER TABLE public.rls_probe_atomic DISABLE ROW LEVEL SECURITY;
      REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM supabase_auth_admin;`);
    try {
      await expect(sql.unsafe(rlsSql)).rejects.toThrow(/lost EXECUTE on custom_access_token_hook/);
      const [flags] = await sql<{ rls: boolean }[]>`
        SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.rls_probe_atomic'::regclass`;
      expect(flags?.rls).toBe(false); // the failed run was rolled back as a whole
    } finally {
      await sql.unsafe(`
        GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
        DROP TABLE IF EXISTS public.rls_probe_atomic;`);
    }
    await sql.unsafe(rlsSql); // and with the grant back, it applies again
  });

  it('applies cleanly to an empty database, and when the locked roles do not exist', async () => {
    const name = await createScratchDatabase();
    const notices: string[] = [];
    const other = postgres(urlFor(adminUrl as string, name), {
      max: 1,
      prepare: false,
      onnotice: (notice) => notices.push(String((notice as { message?: string }).message ?? '')),
    });
    try {
      await other.unsafe(rlsSql); // nothing in public at all
      const [trigger] = await other<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_event_trigger WHERE evtname = 'atlas_enable_rls_on_new_tables'`;
      expect(trigger?.n).toBe(1);

      // Without the event trigger, a table starts out unprotected; the run must then fix it
      // while skipping roles that do not exist on this server.
      await other.unsafe('DROP EVENT TRIGGER atlas_enable_rls_on_new_tables');
      await other.unsafe('CREATE TABLE public.t (id int)');
      const suffix = randomBytes(4).toString('hex');
      const absent = replaceOnce(
        replaceOnce(
          rlsSql,
          `ARRAY['anon', 'authenticated']`,
          `ARRAY['rls_absent_a_${suffix}', 'rls_absent_b_${suffix}']`,
        ),
        `'supabase_auth_admin'`,
        `'rls_absent_c_${suffix}'`,
      );
      await other.unsafe(absent);
      const [flags] = await other<{ rls: boolean }[]>`
        SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.t'::regclass`;
      expect(flags?.rls).toBe(true);
      expect(notices.some((message) => message.includes('roles not present, skipped'))).toBe(true);
    } finally {
      await other.end({ timeout: 5 }).catch(noop);
    }
  }, 60_000);
});
