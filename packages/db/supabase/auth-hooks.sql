-- Supabase-specific auth plumbing that Drizzle deliberately does not manage
-- (it lives in/references the `auth` schema, which is owned by Supabase, not
-- by our migrations). Applied once via the Supabase MCP / dashboard SQL
-- editor against the project, not through `pnpm db:migrate`.
--
-- Two pieces:
--   1. handle_new_user() — mirrors what services/auth's register.ts /
--      oauth-callback.ts used to do by hand: create the public.users row
--      whenever a row is inserted into auth.users. It deliberately does NOT
--      create organizations or memberships (see the note inside the function).
--   2. custom_access_token_hook() — a Custom Access Token Auth Hook that
--      injects this user's primary organization_id/role into
--      app_metadata on every JWT Supabase issues, so packages/auth-kit can
--      reconstruct the actor shape without a DB round trip.

-- 1. Link public.users to its auth.users row and keep it in sync on signup --

-- Guarded so the whole file can be re-applied (e.g. to ship a change to
-- handle_new_user below) without failing on the already-existing constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'users_user_id_fkey' and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_user_id_fkey foreign key (user_id) references auth.users (id) on delete cascade;
  end if;
end
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text;
begin
  v_provider := coalesce(new.raw_app_meta_data ->> 'provider', 'email');

  -- public.users.email is NOT NULL and the sole contact identifier the rest
  -- of the app relies on. GitHub (and, in principle, other OAuth providers)
  -- can omit it when the account has no verified/public email — fail with a
  -- clear, diagnosable error here rather than an opaque NOT NULL violation.
  -- There's no "add your email" follow-up flow yet, so this is a deliberate
  -- reject, not a silent workaround.
  if new.email is null then
    raise exception 'atlas: % sign-in did not return an email address; public.users.email cannot be null', v_provider
      using errcode = '23502';
  end if;

  insert into public.users (user_id, email, full_name, auth_provider, email_verified)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    (case v_provider
      when 'email' then 'password'
      when 'azure' then 'microsoft'
      when 'google' then 'google'
      when 'github' then 'github'
      else 'password'
    end)::auth_provider,
    new.email_confirmed_at is not null
  );

  -- SECURITY: this function must never create an organization or an
  -- organization_members row. It used to turn
  -- raw_user_meta_data.organization_name into a new org plus an `owner`
  -- membership, but raw_user_meta_data is CLIENT-CONTROLLED: anyone holding
  -- the public (anon) Supabase key can call the signup endpoint with
  -- arbitrary `data`, so that made "owner of a brand-new organization" (and
  -- the org admin/owner role that ends up in their JWT through
  -- custom_access_token_hook) something any visitor could grant themselves.
  -- Organizations (e.g. for the university pilot) are created by platform
  -- administrators, who add members explicitly. Only server-trusted input
  -- (new.id, new.email, provider) may drive memberships; if self-serve orgs
  -- are ever wanted, do it from an authenticated, rate-limited, audited
  -- endpoint — not from signup metadata.

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. Custom Access Token Hook: stamp org_id/role into app_metadata ----------

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims jsonb;
  membership record;
begin
  claims := event -> 'claims';

  select m.organization_id, m.role
    into membership
    from public.organization_members m
   where m.user_id = (event ->> 'user_id')::uuid
   order by m.created_at asc
   limit 1;

  if membership.organization_id is not null then
    claims := jsonb_set(
      claims,
      '{app_metadata}',
      coalesce(claims -> 'app_metadata', '{}'::jsonb)
        || jsonb_build_object('org_id', membership.organization_id, 'role', membership.role)
    );
    event := jsonb_set(event, '{claims}', claims);
  end if;

  return event;
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant select on public.organization_members to supabase_auth_admin;

-- Manual step: Dashboard -> Authentication -> Hooks -> Custom Access Token,
-- select public.custom_access_token_hook. Not exposed via any MCP tool.
