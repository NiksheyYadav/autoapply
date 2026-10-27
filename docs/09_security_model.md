# 9. Security Model

## Controls
- RBAC
- MFA
- encryption at rest and in transit
- audit logs
- rate limiting
- anomaly detection

## Token handling
- Encrypt OAuth tokens with KMS-backed envelope encryption.
- Rotate refresh tokens when connectors support it.
- Scope tokens to the minimum required permissions.
- Separate user tokens from organization tokens.

## Data protection
- Classify resumes, cover letters, emails, and CRM exports as sensitive.
- Redact secrets from logs.
- Mask tokens and email addresses in observability pipelines when possible.

## Abuse prevention
- Apply per-user and per-org rate limits.
- Detect unusual automation bursts.
- Flag repeated failed submissions.
- Require step-up authentication for risky actions.

## Compliance posture
- Design for auditability from day one.
- Keep consent records for every connected service.
- Support data export and deletion workflows.

## Database exposure / RLS
Supabase's Data API (PostgREST, `/rest/v1`) serves the `public` schema to anyone holding the publishable (anon) key, which ships in client JS and CI config. Atlas services never use it: they connect to Postgres directly as a privileged role (the table owner, which bypasses RLS). So the posture is deny-all for the client roles, in two independent layers, both set by `packages/db/supabase/rls.sql`:

1. **RLS enabled** (not `FORCE`) on every table in `public`, with **no policies** for `anon` or `authenticated`.
2. **No privileges** for `anon`, `authenticated` or `PUBLIC` on any table, view, sequence or function in `public`, and default privileges changed so objects created later start the same way.

Supabase Auth keeps what it needs (`USAGE` on `public`, `EXECUTE` on `custom_access_token_hook`, `SELECT` on `organization_members`, plus a read-only policy for `supabase_auth_admin` so RLS does not hide the rows); the `handle_new_user` signup trigger is unaffected.

**Applying it.** Like `auth-hooks.sql`, it is not a Drizzle migration. Paste it into the Supabase dashboard SQL editor (as `postgres`) after `pnpm db:migrate` and `auth-hooks.sql`. It is idempotent and atomic: it verifies its own end state (RLS on everywhere, client roles locked out, Auth's grants intact) and rolls back with an explanation if any check fails. Read any WARNING lines it prints; each names a gap it could not close. `scripts/ci/setup-test-db.sh` applies the same file, so CI and local test databases match production, and `packages/db/test/rls.test.ts` proves the behaviour on a scratch database.

**Verifying.**
- Supabase Advisors (Security): `RLS disabled in public` must be clear. `RLS enabled, no policy` will list every table at INFO level; that is the intended deny-all state, so do not "fix" it with permissive policies.
- Request `GET $SUPABASE_URL/rest/v1/resumes?select=id&limit=1` with only `apikey: <publishable key>`. Expect `401` with `permission denied for table resumes` (or `404` if the Data API is off). `[]` means RLS is holding but a grant is still present: re-run `rls.sql`. Any row is an incident.
- Defense in depth: in the project's Data API settings, remove `public` from the exposed schemas or turn the Data API off, since we do not use it.

**Rules.**
- New tables need no manual step: an event trigger enables RLS on tables created in `public`, and default privileges give the client roles nothing. If `rls.sql` warned that it could not create the event trigger, re-run it after each migration that adds tables.
- New roles do need attention. The file only knows the roles in `v_locked_roles` (`anon`, `authenticated`); add any new client-facing role there and re-run. A role that legitimately needs data gets an explicit `GRANT` (and a policy, unless it owns the table or has `BYPASSRLS`), as does any role that must call a new function.
- Never `GRANT` to `anon`/`authenticated` in a migration. To expose something through the Data API on purpose, follow the header of `rls.sql` (add the name to `v_data_api_objects`, grant narrowly, write the policy); otherwise the next run revokes it.
