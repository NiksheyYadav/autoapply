-- Data API lockdown for the `public` schema: Row Level Security on every table,
-- and no table/sequence/function privileges for Supabase's client-facing roles.
--
-- HOW TO APPLY: like auth-hooks.sql, this is NOT a Drizzle migration. Run it by
-- hand in the Supabase dashboard SQL editor (as `postgres`) after `pnpm db:migrate`
-- and auth-hooks.sql. scripts/ci/setup-test-db.sh also applies it, after the auth
-- hooks, so CI and local test databases have the same posture as production.
-- It is idempotent and atomic (one DO block): re-run it any time, and if
-- anything cannot be guaranteed it aborts and changes nothing.
--
-- WHY: Supabase's Data API (PostgREST, /rest/v1) serves the `public` schema to
-- anyone holding the publishable (anon) key, and that key ships in client JS.
-- Out of the box, Supabase grants `anon` and `authenticated` ALL on everything
-- created in `public`, so without RLS the key alone could read resumes, messages,
-- contacts, connector_accounts, ... Atlas services never use the Data API: they
-- connect straight to Postgres with a privileged DATABASE_URL role (the table
-- owner, which bypasses RLS because we use ENABLE, never FORCE). So the safe
-- default is deny-all, in two independent layers:
--
--   1. RLS is enabled on every table in `public` and NO policy targets
--      anon/authenticated (default deny, even if a grant sneaks back in).
--   2. anon/authenticated (and PUBLIC) hold no privileges on any table, view,
--      sequence or function in `public`, and default privileges are changed so
--      objects created later start out the same way.
--
-- WHAT THIS DOES NOT TOUCH
--   * supabase_auth_admin: Supabase Auth keeps USAGE on schema public, EXECUTE on
--     custom_access_token_hook and SELECT on organization_members (granted by
--     auth-hooks.sql; this file never names that role in a REVOKE). Because RLS
--     would otherwise hide every row from it, it also gets a read-only policy on
--     organization_members. The hook is SECURITY DEFINER, so it reads as the table
--     owner anyway; the policy only keeps the documented grant meaningful. The
--     handle_new_user trigger needs no EXECUTE grant to fire (Postgres checks
--     that at CREATE TRIGGER), so revoking it from PUBLIC does not break signup.
--   * service_role and the owner: unchanged. Rotate the service_role key if it
--     ever leaks; that is a separate secret-handling concern.
--   * schema USAGE on `public` for anon/authenticated: left alone (harmless
--     without table privileges). For belt and braces, also remove `public` from
--     Dashboard -> Settings -> Data API -> Exposed schemas, or turn the Data API off.
--
-- NEW TABLES need no manual step. An event trigger (created below; if your role
-- may not create event triggers you get a WARNING and should re-run this file after
-- each migration that adds tables) enables RLS on every table created in `public`,
-- and the default privileges set below keep it unreachable by anon/authenticated.
-- NEW ROLES do: this file only knows the roles in v_locked_roles. A new role that
-- must never reach the Data API has to be added there and the file re-run; a role
-- that legitimately needs data needs an explicit GRANT (and, unless it owns the
-- table or has BYPASSRLS, a policy), because nothing is granted by default.
--
-- EXPOSING A TABLE THROUGH THE DATA API LATER (only if a client really needs it):
--   1. Add its name to v_data_api_objects below, else the next run revokes the grant.
--   2. Grant only what is needed:  grant select on public.t to authenticated;
--   3. Write the policy (RLS is already on):
--        create policy "members read their rows" on public.t
--          for select to authenticated using (user_id = (select auth.uid()));
--   The grant without the policy returns zero rows; the policy without the grant
--   is never reached. Functions need `grant execute` the same way.
--
-- Not emulated by infra/ci/supabase-stub.sql: Supabase's default grants to anon and
-- authenticated. packages/db/test/rls.test.ts recreates that baseline itself and
-- proves this file removes it.

-- Event trigger function: enable RLS on tables created in `public` from now on. It
-- must never make the CREATE TABLE itself fail, hence the exception handler.
CREATE OR REPLACE FUNCTION public.atlas_enable_rls_on_new_tables()
RETURNS event_trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
      FROM pg_event_trigger_ddl_commands()
     WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
       AND object_type IN ('table', 'partitioned table')
       AND schema_name = 'public'
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE IF EXISTS %s ENABLE ROW LEVEL SECURITY', cmd.object_identity);
    EXCEPTION WHEN others THEN
      RAISE WARNING 'atlas rls: could not enable RLS on %: %', cmd.object_identity, SQLERRM;
    END;
  END LOOP;
END;
$$;

DO $rls$
DECLARE
  -- ---- configuration: the only lines you should ever need to edit -------------
  -- Roles that must never reach `public` data (skipped when they do not exist).
  v_locked_roles     constant text[] := ARRAY['anon', 'authenticated'];
  -- Supabase Auth's role; its grants from auth-hooks.sql are verified, never revoked.
  v_auth_admin       constant text   := 'supabase_auth_admin';
  -- Tables, views, sequences or functions deliberately exposed via the Data API:
  -- skipped by the revokes and the final check. Empty by design.
  v_data_api_objects constant text[] := ARRAY[]::text[];
  -- -----------------------------------------------------------------------------
  v_present  text[];
  v_exposed  text;
  v_obj      record;
  v_creator  text;
  v_kind     text;
  v_enabled  int := 0;
  v_skipped  int := 0;
  v_problems text;
BEGIN
  -- Do not queue behind a long transaction while holding the lock queue hostage:
  -- ENABLE ROW LEVEL SECURITY takes a brief ACCESS EXCLUSIVE lock per table.
  PERFORM set_config('lock_timeout', '15s', true);

  SELECT coalesce(array_agg(rolname::text ORDER BY rolname), ARRAY[]::text[])
    INTO v_present
    FROM pg_roles
   WHERE rolname = ANY (v_locked_roles);
  SELECT string_agg(quote_ident(r), ', ') INTO v_exposed FROM unnest(v_present) AS u(r);
  IF cardinality(v_present) < cardinality(v_locked_roles) THEN
    RAISE NOTICE 'atlas rls: roles not present, skipped: %',
      (SELECT string_agg(r, ', ') FROM unnest(v_locked_roles) AS u(r) WHERE r <> ALL (v_present));
  END IF;

  -- 1. RLS on every ordinary (and partitioned) table in public. Found dynamically,
  --    so tables added later are covered the next time this runs. ENABLE, not
  --    FORCE: the owner (our services) and BYPASSRLS roles keep working. Tables
  --    that belong to an extension are not ours to alter and are skipped.
  FOR v_obj IN
    SELECT format('%I.%I', n.nspname, c.relname) AS ident
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_obj.ident);
    v_enabled := v_enabled + 1;
  END LOOP;

  -- 2. Enable RLS automatically on tables created from now on. Guarded: creating an
  --    event trigger needs privileges some hosted roles lack. Left in place if it
  --    already exists (the function above was just refreshed).
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'atlas_enable_rls_on_new_tables') THEN
      EXECUTE 'CREATE EVENT TRIGGER atlas_enable_rls_on_new_tables ON ddl_command_end '
           || 'WHEN TAG IN (''CREATE TABLE'', ''CREATE TABLE AS'', ''SELECT INTO'') '
           || 'EXECUTE FUNCTION public.atlas_enable_rls_on_new_tables()';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING 'atlas rls: cannot create the event trigger that enables RLS on new tables (%). '
                  'Re-run this file after every migration that adds tables.', SQLERRM;
  END;

  IF cardinality(v_present) > 0 THEN
    -- 3. Take back privileges on everything that exists. PUBLIC is included
    --    because anon/authenticated inherit from it (functions are executable by
    --    PUBLIC by default). Extension-owned objects are best effort: ones owned by
    --    a role we cannot act as are skipped (counted in a NOTICE), a failure on
    --    the rest is a warning; a failure on our own objects aborts the script.

    -- 3a. Tables, views, materialized views, foreign tables and sequences.
    FOR v_obj IN
      SELECT format('%I.%I', n.nspname, c.relname) AS ident,
             CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind,
             EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') AS is_ext,
             pg_has_role(current_user, c.relowner, 'USAGE') AS can_alter
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         AND c.relname::text <> ALL (v_data_api_objects)
    LOOP
      IF v_obj.is_ext AND NOT v_obj.can_alter THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
      BEGIN
        EXECUTE format('REVOKE ALL ON %s %s FROM PUBLIC, %s', v_obj.kind, v_obj.ident, v_exposed);
      EXCEPTION WHEN others THEN
        IF NOT v_obj.is_ext THEN RAISE; END IF;
        RAISE WARNING 'atlas rls: could not revoke on extension object %: %', v_obj.ident, SQLERRM;
      END;
    END LOOP;

    -- 3b. Functions, procedures and aggregates (RPC endpoints in the Data API).
    FOR v_obj IN
      SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS ident,
             EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') AS is_ext,
             pg_has_role(current_user, p.proowner, 'USAGE') AS can_alter
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname::text <> ALL (v_data_api_objects)
    LOOP
      IF v_obj.is_ext AND NOT v_obj.can_alter THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
      BEGIN
        EXECUTE format('REVOKE ALL ON ROUTINE %s FROM PUBLIC, %s', v_obj.ident, v_exposed);
      EXCEPTION WHEN others THEN
        IF NOT v_obj.is_ext THEN RAISE; END IF;
        RAISE WARNING 'atlas rls: could not revoke on extension routine %: %', v_obj.ident, SQLERRM;
      END;
    END LOOP;

    -- 4. Default privileges, so objects created later start out locked. Supabase
    --    seeds `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ... TO anon,
    --    authenticated` per creating role; clear it for this role and for every
    --    role that has such an entry. A role we may not alter is a warning.
    FOR v_creator IN
      SELECT current_user::text
      UNION
      SELECT pg_get_userbyid(defaclrole)::text FROM pg_default_acl WHERE defaclnamespace = 'public'::regnamespace
    LOOP
      BEGIN
        FOREACH v_kind IN ARRAY ARRAY['TABLES', 'SEQUENCES', 'FUNCTIONS'] LOOP
          EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON %s FROM %s',
                         v_creator, v_kind, v_exposed);
        END LOOP;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE WARNING 'atlas rls: cannot change default privileges of role % (objects it creates in public may be '
                      'exposed to %): %', v_creator, v_exposed, SQLERRM;
      END;
    END LOOP;
    -- New functions are executable by PUBLIC (hence by anon) unless that default is
    -- revoked, and IN SCHEMA cannot subtract from it, so this one is not schema
    -- scoped. It only affects functions this role creates; grant EXECUTE explicitly
    -- to any other role that must call them (auth-hooks.sql already does).
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', current_user);
  END IF;

  IF v_skipped > 0 THEN
    RAISE NOTICE 'atlas rls: left % extension-owned object(s) in public untouched (owned by a role this one cannot act as)',
      v_skipped;
  END IF;

  -- 5. Keep Supabase Auth's read of organization_members meaningful under RLS.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_auth_admin)
     AND to_regclass('public.organization_members') IS NOT NULL THEN
    DROP POLICY IF EXISTS atlas_auth_admin_select ON public.organization_members;
    EXECUTE format('CREATE POLICY atlas_auth_admin_select ON public.organization_members '
                   'AS PERMISSIVE FOR SELECT TO %I USING (true)', v_auth_admin);
  END IF;

  -- 6. Verify the end state in the same transaction. Any finding aborts the whole
  --    script (nothing is applied), so a half-hardened or auth-breaking state is
  --    never committed. Extension-owned objects are excluded from the checks.
  SELECT string_agg(x.msg, E'\n' ORDER BY x.msg)
    INTO v_problems
    FROM (
      SELECT format('  RLS is not enabled on table %I.%I', n.nspname, c.relname) AS msg
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
         AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      UNION ALL
      SELECT format('  role %s can still access %I.%I', u.r, n.nspname, c.relname)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(v_present) AS u(r)
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND c.relname::text <> ALL (v_data_api_objects)
         AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
         AND (has_any_column_privilege(u.r::name, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
              OR has_table_privilege(u.r::name, c.oid, 'DELETE,TRUNCATE,TRIGGER'))
      UNION ALL
      SELECT format('  role %s can still use sequence %I.%I', u.r, n.nspname, c.relname)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(v_present) AS u(r)
       WHERE n.nspname = 'public' AND c.relkind = 'S'
         AND c.relname::text <> ALL (v_data_api_objects)
         AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
         AND has_sequence_privilege(u.r::name, c.oid, 'USAGE,SELECT,UPDATE')
      UNION ALL
      SELECT format('  role %s can still execute %s', u.r, p.oid::regprocedure)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       CROSS JOIN unnest(v_present) AS u(r)
       WHERE n.nspname = 'public'
         AND p.proname::text <> ALL (v_data_api_objects)
         AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
         AND has_function_privilege(u.r::name, p.oid, 'EXECUTE')
    ) AS x;

  -- Supabase Auth: if auth-hooks.sql has been applied, its three grants must still hold.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_auth_admin)
     AND to_regprocedure('public.custom_access_token_hook(jsonb)') IS NOT NULL THEN
    IF NOT has_schema_privilege(v_auth_admin, 'public', 'USAGE') THEN
      v_problems := concat_ws(E'\n', v_problems, format('  %s lost USAGE on schema public', v_auth_admin));
    END IF;
    IF NOT has_function_privilege(v_auth_admin, 'public.custom_access_token_hook(jsonb)', 'EXECUTE') THEN
      v_problems := concat_ws(E'\n', v_problems, format('  %s lost EXECUTE on custom_access_token_hook', v_auth_admin));
    END IF;
    IF to_regclass('public.organization_members') IS NOT NULL
       AND NOT has_table_privilege(v_auth_admin, 'public.organization_members', 'SELECT') THEN
      v_problems := concat_ws(E'\n', v_problems, format('  %s lost SELECT on organization_members', v_auth_admin));
    END IF;
  END IF;

  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION E'atlas rls: refusing to commit, the end state is not safe:\n%', v_problems;
  END IF;

  RAISE NOTICE 'atlas rls: enabled RLS on % table(s) this run; %',
    v_enabled,
    CASE WHEN v_exposed IS NULL THEN 'no locked roles exist on this server, so no privileges were changed'
         ELSE format('%s hold no privileges on public tables, sequences or functions', v_exposed) END;
END
$rls$;
