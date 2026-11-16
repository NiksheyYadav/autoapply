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
- `pnpm test` — 17 files passed, 9 skipped; **114 tests passed, 51 skipped**. The skips are the DB-backed integration suites, which self-skip without `ATLAS_TEST_DATABASE_URL`. Earlier records show 125 passed / 55 skipped before the Supabase migration; the drop coincides with auth-service being cut down and was not investigated separately.

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
