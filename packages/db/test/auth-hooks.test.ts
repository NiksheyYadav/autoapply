import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/client.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const authHooksPath = fileURLToPath(new URL('../supabase/auth-hooks.sql', import.meta.url));
const authHooksSql = readFileSync(authHooksPath, 'utf8');

/** The `create or replace function public.handle_new_user() ... $$;` statement, verbatim from the file. */
function extractHandleNewUser(sql: string): string {
  const match = /create or replace function public\.handle_new_user\(\)[\s\S]*?\n\$\$;/.exec(sql);
  expect(match, 'handle_new_user() definition not found in auth-hooks.sql').not.toBeNull();
  return match![0];
}

const handleNewUserSql = extractHandleNewUser(authHooksSql);

describe('handle_new_user (auth-hooks.sql), static', () => {
  it('never creates an organization or membership from signup metadata', () => {
    // Comments may (and do) explain the old behavior; check the executable text only.
    const executable = handleNewUserSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(executable).not.toMatch(/organization_name/i);
    expect(executable).not.toMatch(/insert\s+into\s+public\.organizations/i);
    expect(executable).not.toMatch(/insert\s+into\s+public\.organization_members/i);
  });

  it('still provisions the public.users row', () => {
    expect(handleNewUserSql).toMatch(/insert\s+into\s+public\.users/i);
  });
});

/** Thrown inside a transaction purely to force a rollback after the assertions' data is collected. */
class Rollback extends Error {}

describe.skipIf(!testDatabaseUrl)('handle_new_user (auth-hooks.sql), against Postgres', () => {
  let dbHandle: DatabaseHandle;

  beforeAll(() => {
    dbHandle = createDatabase({ url: testDatabaseUrl!, maxConnections: 2 });
  });

  afterAll(async () => {
    await dbHandle.close();
  });

  it('does not turn a client-supplied organization_name into an organization + owner membership', async () => {
    const userId = randomUUID();
    const orgName = `Self-Granted Org ${randomUUID()}`;
    const email = `auth-hooks-${userId}@example.com`;
    let observed: { userRows: number; orgRows: number; membershipRows: number } | undefined;

    // Everything — including (re)defining the function from the file under test —
    // happens in one transaction that is always rolled back, so this never
    // mutates the shared test database or leaves rows behind.
    await dbHandle.sql
      .begin(async (tx) => {
        await tx.unsafe(handleNewUserSql);
        await tx`
          insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
          values (
            ${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(),
            '{"provider":"email"}'::jsonb,
            ${JSON.stringify({ full_name: 'Mallory', organization_name: orgName })}::jsonb,
            now(), now()
          )
        `;
        const [users] = await tx`select count(*)::int as n from public.users where user_id = ${userId}`;
        const [orgs] = await tx`select count(*)::int as n from public.organizations where name = ${orgName}`;
        const [memberships] = await tx`select count(*)::int as n from public.organization_members where user_id = ${userId}`;
        observed = { userRows: users!.n, orgRows: orgs!.n, membershipRows: memberships!.n };
        throw new Rollback();
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof Rollback)) throw cause;
      });

    expect(observed).toEqual({ userRows: 1, orgRows: 0, membershipRows: 0 });

    // And the rollback really did leave nothing behind.
    const [leftover] = await dbHandle.sql`select count(*)::int as n from public.users where user_id = ${userId}`;
    expect(leftover!.n).toBe(0);
  });
});
