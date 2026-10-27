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

## Data export and deletion
Both are self-service and served by auth-service, acting only on the caller (the user id comes from the verified token; neither route takes one). The web app exposes them at `/dashboard/settings` ("Your data").

**Export: `GET /v1/auth/me/export`.** One JSON download (`Content-Disposition: attachment`, `Cache-Control: no-store`) of the account, memberships and student records, resumes (metadata, parsed text, parsed profile, ATS report), applications with their event trail, messages, job scores, activity events and connected-account bookkeeping. Never included: password hash, MFA secret, lockout counters, storage keys, content hashes, embeddings, idempotency keys, connector `secret_ref`, or any other user's data (messages reference contacts by id only). The original resume files are not included. The file lists these exclusions in its own `notes`. Size is bounded twice: a row cap per section (in SQL) and a 3.5 MB budget on the serialized file, since Vercel Functions cannot return more than 4.5 MB; whatever is cut is listed in the file's `truncated` array, so a partial export never reads as complete. Referral suggestions are computed on demand, not stored, so they have no section.

**Deletion: `DELETE /v1/auth/me` with `{ "confirm": "DELETE" }`.** One transaction: either everything below is gone or nothing is.
1. `delete from auth.users where id = $user` is the root. `public.users` references it `ON DELETE CASCADE` (`packages/db/supabase/auth-hooks.sql`) and the user-owned tables cascade from `public.users`: `organization_members`, `students`, `resumes`, `applications` (then `application_events`, and `messages` that point at them), `messages`, `job_scores`, `connector_accounts`, `idempotency_keys`.
2. Explicit deletes for what no cascade reaches: `analytics_events` (its FK is `SET NULL`, which would orphan the row), `event_outbox` (no FK by design; `event_deliveries` cascades from it), `tasks` (payload only), the user's own `audit_logs` entries about their account, and personal (`individual`) organizations the user was the only member of. Events are matched on the `user_id` column or on `payload.user_id`. Audit entries where the user acted inside an organization are kept, with the actor nulled by its FK. Institutional organizations (university, enterprise) are never deleted because one member left. Jobs, companies and contacts are shared and stay.
3. After the commit, the user's resume files (`resumes/{user_id}/{content_hash}`) are deleted through the `StorageDriver`, best effort: a failure is logged (user id, counts, error classes) and reported in the response (`resume_files.failed`), and does not undo the deletion. The auth service therefore needs the same `STORAGE_DRIVER` / `SUPABASE_STORAGE_BUCKET` / `SUPABASE_SECRET_KEY` as profile-service (shared automatically when all services are one Vercel project). Files whose removal failed stay under `resumes/{user_id}/` in the bucket and have to be removed by hand; nothing re-tries them.
4. The only row that outlives the user is a tombstone in `audit_logs`: `action = 'account.deleted'`, `resource_id` = the user id, no actor, counts only. An export writes an `account.export` row the same way (user id and a count, no PII), which is removed with the account.

**Refusals (409 `CONFLICT`, nothing deleted).** `details.reason` is `sole_owner_of_organization` when the user is the only `owner` of an organization with any other member or roster student, and `active_connected_accounts` when the user, or an organization that would be deleted with them, still has a connected account that is not revoked. The second exists because credentials live in the connector secret store, which auth-service cannot reach: deleting the row would leave a credential nothing points at, so the user disconnects first (connectors-service revokes the secret).

**How the Supabase auth user is removed.** auth-service holds `DATABASE_URL` (a privileged role) and no Supabase secret key, so it deletes the row directly, inside the same transaction, rather than calling the Auth admin API. Implications for production:
- The `DATABASE_URL` role must be allowed to `DELETE` from `auth.users` (Supabase's `postgres` role is). A least-privilege role would need that grant.
- GoTrue is not asked to do it, so it runs no logic of its own. Its own tables (identities, sessions, refresh tokens, MFA factors) are Supabase's, with their own cascading foreign keys that `infra/ci/supabase-stub.sql` does not model (the stub has `auth.users` only). The CI tests prove the `public` side; confirm the rest once on a staging project: sign up a throwaway user, upload a resume, delete the account, then check that no row is left in `auth.*` and the file is gone from the bucket.
- Access tokens already issued stay valid until they expire (services verify JWTs against the JWKS and do not look the user up), so a deleted user's token still passes verification for up to the project's JWT lifetime; what it can reach finds no data for them. Their refresh tokens go with the cascade, so the session cannot be renewed. Other open tabs show the API as unavailable until then.
- On a Postgres without an `auth` schema (plain local development) the `auth.users` step is skipped and `public.users` is deleted directly.

**Abuse limits and logging.** Per client address, separate from the general budget: export 10 and delete 3 per hour (`PRIVACY_EXPORT_RATE_LIMIT_MAX`, `PRIVACY_DELETE_RATE_LIMIT_MAX`, `PRIVACY_RATE_LIMIT_WINDOW`); counters are per function instance, like the general limiter. Both actions are logged with `audit: true` and the user id only, and no name, email, file name or storage error message.

**Not covered.** Deletion rewrites no database backups and no log archives held by Supabase, Vercel or other providers. Data already given to others (an organization's staff export, a message already sent) is outside Atlas's reach.

**Keeping it true.** `services/auth/test/delete-account.test.ts` reads every uuid column named like a user reference from `information_schema`, fails if the set differs from the one it knows, and then scans every table for the user's id, email, name and content markers after a deletion. A new table that references a user must be added to `repo/delete-account.ts` and to that test's seed data in the same change.
