-- Minimal stand-in for the parts of Supabase that Atlas' database layer
-- depends on, so a plain Postgres can run the DB-backed integration tests.
--
-- CI / LOCAL TEST DATABASES ONLY. NEVER apply this to a real Supabase project
-- or to any production/staging database: there, `auth` is owned and migrated
-- by Supabase (GoTrue) and these roles already exist with real privileges.
-- The guard below refuses to run if it detects a real Supabase auth schema.
--
-- Why it exists: packages/db/supabase/auth-hooks.sql (applied after
-- `pnpm db:migrate`) adds a foreign key from public.users to auth.users and a
-- trigger on auth.users, and grants to Supabase's roles. A vanilla Postgres has
-- none of those, and the integration tests create their users by inserting into
-- auth.users (which fires handle_new_user). This file provides exactly that:
--
--   * the roles auth-hooks.sql grants to / revokes from (NOLOGIN, so they are
--     inert: they can own grants but nobody can connect as them);
--   * schema `auth` and a table `auth.users` with the columns the tests insert
--     and handle_new_user reads. Types follow Supabase's real auth.users; the
--     rest of GoTrue's columns (encrypted_password, identities, ...) are
--     deliberately omitted because nothing here reads them.
--
-- Not emulated: GoTrue itself, JWT issuing, auth.uid()/auth.jwt(), RLS. The
-- tests mint their own JWTs against a stubbed JWKS instead.
--
-- Idempotent: safe to run repeatedly. Order of use (scripts/ci/setup-test-db.sh):
--   1. this file   2. `pnpm db:migrate`   3. packages/db/supabase/auth-hooks.sql

BEGIN;

-- Refuse to run against a real Supabase database. GoTrue's own bookkeeping
-- tables exist there and never exist in a stand-in created by this file.
DO $$
BEGIN
  IF to_regclass('auth.schema_migrations') IS NOT NULL
     OR to_regclass('auth.identities') IS NOT NULL THEN
    RAISE EXCEPTION
      'supabase-stub.sql: this looks like a real Supabase database (auth.schema_migrations / auth.identities exist). Refusing to continue; this stub is for throwaway CI/test databases only.';
  END IF;
END
$$;

-- Roles referenced by auth-hooks.sql. Roles are cluster-wide, so create them
-- only when missing (and tolerate a concurrent creator).
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['supabase_auth_admin', 'authenticated', 'anon'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      EXCEPTION WHEN duplicate_object THEN
        NULL; -- created concurrently by another session; that is fine
      END;
    END IF;
  END LOOP;
END
$$;

CREATE SCHEMA IF NOT EXISTS auth;

-- Column subset of Supabase's auth.users, with the same types. No defaults on
-- created_at/updated_at: as in Supabase, the inserting side supplies them.
CREATE TABLE IF NOT EXISTS auth.users (
  instance_id        uuid,
  id                 uuid PRIMARY KEY,
  aud                varchar(255),
  role               varchar(255),
  email              varchar(255),
  email_confirmed_at timestamptz,
  raw_app_meta_data  jsonb,
  raw_user_meta_data jsonb,
  created_at         timestamptz,
  updated_at         timestamptz
);

COMMIT;
