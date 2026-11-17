# 15 — Progress report

> **Superseded for current status.** The launch-prep branch (PR #8) keeps the verified, up-to-date status in [`15_progress.md`](15_progress.md) and the owner-only steps in [`16_launch_checklist.md`](16_launch_checklist.md). This file is the earlier snapshot taken at `0a755b4`; several rows below (for example priority 5, university administration) describe the code as it was then.

**As of:** 2026-10-27 · **Code baseline:** `feat/profile-jobs-services` @ `0a755b4`

This file is the living status record for Project Atlas. Update it at the end of each working session: change the date and baseline, move items between sections, and keep "Next steps" ordered.

## How to read the evidence

| Label                        | Meaning                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| **Verified 2026-10-27**      | Re-run in the session that wrote this report.                                    |
| **Last verified 2026-10-02** | Checked against live infrastructure in an earlier session; not re-checked since. |
| **Unverified**               | Written but never exercised against the real thing.                              |

## Verified 2026-10-27

Run from a clean worktree at `0a755b4` after `pnpm install --frozen-lockfile`:

- `pnpm typecheck` — clean
- `pnpm lint` — clean
- `pnpm test` — 17 files passed, 9 skipped; **114 tests passed, 51 skipped** at `0a755b4`. The skips are the DB-backed integration suites, which self-skip without `ATLAS_TEST_DATABASE_URL`. On `main` at `1c5d852` the same command gives **1275 passed, 429 skipped** (89 files passed, 29 skipped); see "Test-count history" below.

### Test-count history

The "125 passed / 55 skipped" figure was first written in `6bdcd64` (2026-10-27); no earlier record of it exists in history.

- **Verified (2026-11-17), from history:** the Supabase auth cut-down `23e159d` (2026-09-27, "shrink auth-service to just /me + /health") deleted exactly four test files under `services/auth/test/`: `password.test.ts` (4 tests), `tokens.test.ts` (5), `oauth-flow.test.ts` (6) and `auth-flow.test.ts` (4, behind `describe.skipIf(!testDatabaseUrl)`). Between `23e159d^` and `0a755b4` those are the only deleted or added test files (30 files to 26, and 26 = 17 passed + 9 skipped). That removes 15 always-run tests and 4 DB-gated ones, so skipped goes 55 to 51 exactly. The same range adds three tests in `packages/db/test/schema.test.ts` (Supabase provisioning checks).
- **Intentional:** the deleted tests covered password hashing, self-issued access/refresh tokens, the OAuth state cookie and the register/login/refresh flow. All of that code was removed in `23e159d` in favour of Supabase Auth, so no test guarding live behaviour was lost. Token verification is covered by `packages/auth-kit/test/tokens.test.ts`.
- **Unverified:** that `23e159d^` actually printed 125 passed / 55 skipped. The old tree could not be installed and run offline in the sandbox. By the test-file diff the passed count would be 125 - 15 + 3 = 113 against the recorded 114, a gap of one test that I did not trace.
- **Why 114/51 became 1275/429 (Verified 2026-11-17, counts from `pnpm test` on `1c5d852`):** since `0a755b4`, 92 test files were added (26 files to 118). By directory: `services/*` 57 (admin 11, jobs 9, auth 7, applications 6, matching 5, analytics 4, learning 4, outreach 4, referrals 4, profile 3, connectors 1), `apps/*` 19 (admin 10, web 9), `packages/*` 16 (messaging 6, db 3, utils 2, ai, auth-kit, observability, storage 1 each). The root vitest run also now includes `apps/*/test` (`809e492`). Most added suites are DB-backed and self-skip without `ATLAS_TEST_DATABASE_URL`, which is why skipped grew from 51 to 429. Per-file test counts for the new suites were not tallied.

## Status against CLAUDE.md priorities

| #   | Priority                                                         | Status                                                                                                |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Core architecture and repo structure                             | Done — pnpm/turbo monorepo, shared `packages/*`, per-service layout                                   |
| 2   | Database schema and service boundaries                           | Done — Drizzle schema + migrations in `packages/db`; Supabase-specific SQL in `packages/db/supabase/` |
| 3   | Auth, profile ingestion, job discovery                           | Done — auth now Supabase Auth; profile and jobs services built                                        |
| 4   | Matching, resume optimization, applications, referrals, outreach | Done — resume optimization lives in `@atlas/ai`'s ATS scorer, not a separate service                  |
| 5   | University / enterprise administration                           | Done — `services/learning`, `services/analytics`, `services/connectors`, and `apps/admin`             |
| 6   | Observability, security hardening, deployment automation         | **Partial** — see below                                                                               |

### Priority 6 detail

- Done: GitHub Actions CI (`.github/workflows/ci.yml`: backend typecheck/lint/test plus a frontend build matrix); `@atlas/observability` Prometheus metrics on every backend service; Vercel deployment.
- Deliberately not attempted: Kubernetes manifests, Dockerfiles, OpenTelemetry tracing, MFA, anomaly detection. None can be verified in the development sandbox (no Docker daemon, no cluster, no collector), so they would ship unchecked. Treat any decision to proceed as a change to the verification story, not a routine task.

## What exists

**Backend services** (`services/`): auth, profile, jobs, matching, applications, referrals, outreach, learning, analytics, connectors, plus `services/ai`.
**Frontends** (`apps/`): `web` (candidate app and landing page), `admin` (organization operations dashboard).
**Shared packages** (`packages/`): ai, auth-kit, config, db, messaging, observability, storage, types, ui, utils.

The `ui` package carries the "Obsidian" design system (black canvas, single gold accent, single dark theme). It replaced the earlier "Waypoint" system; do not reintroduce light/dark switching unless asked.

## Auth and data

- Authentication and Postgres moved from Neon + self-issued JWTs to **Supabase** (phases 1–5 of the migration plan are done). Services verify Supabase-issued JWTs via JWKS through `@atlas/auth-kit`.
- `services/auth` is reduced to `GET /v1/auth/me` and `/health`. `/me` does a fresh permissions lookup because permissions can change faster than a token's lifetime.
- Google and GitHub sign-in are configured in Supabase. Microsoft (`azure` in Supabase) is **not** configured.
- `0a755b4` (on this branch, **not yet in `main`**) improves sign-in error messages for accounts created through OAuth and handles the email-confirmation case on sign-up.

## Deployment

**Last verified 2026-10-02.** One Vercel project serves all backend services from esbuild-bundled functions under `api/`; separate projects serve `apps/web` and `apps/admin`. All nine public route prefixes returned auth-gated 401s on the deployed backend.

- **Rebundle on every backend change:** run `node scripts/bundle-backend.mjs` and commit `api/`. Vercel detects functions from the git checkout before the build runs, so the generated output must be committed.
- PDF upload and parsing on Vercel has **not** been exercised with a real file.

## Known gaps and open decisions

1. **Event-driven pipeline does not run on Vercel.** Workers in matching, referrals, analytics, and learning need a persistent process and a real broker; serverless functions provide neither. Only the direct-HTTP half of the product works there. Fixing it means a real RabbitMQ plus a persistent worker host, or converting workers to cron-triggered polling endpoints.
2. **No transactional outbox.** Every event-publishing route commits its DB write before publishing, so a broker failure after commit loses the event permanently. Needs an outbox table and a relay — new cross-cutting infrastructure.
3. **No platform-level admin role.** Admin gates are per-organization; learning-service's model-health metrics are platform-wide by design but readable by any organization's admin/owner.
4. **Production-only drivers are stubs:** storage `s3`, outreach `smtp`, connectors `kms`. Each throws "not implemented"; only the local/dev drivers work. Connectors cannot go to production until a real secrets backend exists.
5. **Supabase migration phase 6 is outstanding** — see "Next steps".
6. **Authenticated end-to-end data flow against a live backend has never been fully verified** (register → login → real recommendations). The sandbox has no Docker or local Postgres, and the DB-backed test suites skip.
7. Billing is out of scope and not in the roadmap.

## Next steps (in order)

1. **Merge `0a755b4` to `main`** (this PR). `main` is otherwise current with the last merged work.
2. **Supabase migration phase 6.** The legacy columns `password_hash`, `mfa_enabled`, `mfa_secret`, `failed_login_count`, and `locked_until` are still in `packages/db/src/schema/identity.ts`; the `sessions` table is already gone (migration `0001`). Before dropping them:
   - `mfa_enabled` is part of the public user type in `packages/types/src/identity.ts` and is returned by `/v1/auth/me` and read by both frontends. Removing it changes the API contract — decide whether to drop it from the contract or keep it as a derived value.
   - The migration runs against the live Supabase project and is destructive; apply it deliberately, not as a side effect of other work.
   - Then update `docs/09_security_model.md`, which still describes the pre-Supabase design.
3. **Microsoft sign-in:** configure the `azure` provider in Supabase if it is wanted.
4. **Exercise PDF upload on the deployed backend** with a real resume.
5. **Decide the worker-hosting question** (gap 1) — it gates every event-driven feature.
6. **Decide whether to build the outbox** (gap 2) before real users.

## Actions only the repository owner can take

- Delete the nine superseded per-service Vercel projects (atlas-auth, -profile, -jobs, -matching, -applications, -referrals, -outreach, -learning, -analytics) in the dashboard.
- Rotate the Supabase database credential before any real users.
- Provide a RabbitMQ instance, SMTP credentials, and a secrets backend if the corresponding features are to run for real.
