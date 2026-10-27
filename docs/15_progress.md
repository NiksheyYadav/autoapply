# 15. Progress Report

Status of Project Atlas against `CLAUDE.md` priorities and `docs/11`–`12`.
Verified 2026-10-27 by running the checks below, not by reading commit messages.

## Verified baseline

- `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test` with `ATLAS_TEST_DATABASE_URL` set: 28 files, 183 tests pass, 0 skipped (re-run against a fresh database prepared by `scripts/ci/setup-test-db.sh`).
- Without that variable the DB-backed suites self-skip (10 files, 58 tests). The CI backend job now starts a `pgvector/pgvector:pg17` service, prepares it with `scripts/ci/setup-test-db.sh` and sets the variable, so they are meant to run on every push and PR. **Pending first CI run:** rehearsed locally on Postgres 16, not yet observed in GitHub Actions.
- To run them locally: `DATABASE_URL=<scratch db> scripts/ci/setup-test-db.sh` (stand-in roles and `auth.users` from `infra/ci/supabase-stub.sql`, then `pnpm db:migrate`, then `packages/db/supabase/auth-hooks.sql`), then `ATLAS_TEST_DATABASE_URL=<same url> pnpm test`.

## By priority (`CLAUDE.md`)

| # | Priority | State |
|---|----------|-------|
| 1 | Architecture and repo structure | Done. pnpm/turbo monorepo, 14 docs, CI. |
| 2 | Schema and service boundaries | Done. 18 tables, 3 migrations. |
| 3 | Auth, profile ingestion, job discovery | Done. auth, profile (upload, parse, ATS score), jobs (ingest, dedupe, recommendations). |
| 4 | Matching, resume optimization, applications, referrals, outreach | Done as heuristic MVPs. Resume optimization is `POST /v1/resumes/{id}/optimize` (advisory, stateless). No LLM is wired anywhere; no model API key is configured. |
| 5 | University and enterprise administration | **Not started.** `organizations`, `organization_members`, `students` tables exist; there is no `admin-service` (docs/08). `apps/admin` is a UI over auth, applications, analytics and learning only. |
| 6 | Observability, security hardening, deployment | Partial. Prometheus metrics and Vercel bundles exist. See gaps. |

## Known gaps

- **Not in code at all:** GraphQL, WebSocket, Kafka, Redis client, OpenTelemetry (docs/01, 04, 14 describe them).
- **Rate limiting** uses Fastify's default in-memory store, so limits are per instance, not shared. Needs a shared store before it means much on serverless.
- **`connectors-service`** is built and tested but is not in `scripts/bundle-backend.mjs` or `vercel.json`, so it is not deployed. `apps/web` connectors page is a placeholder.
- **CI** now runs the DB-backed tests (Postgres service in the backend job). It also checks that the committed `api/` bundles are fresh and runs an advisory, non-blocking `pnpm audit`, which currently reports advisories. All three are **pending first CI run**; none has been observed in GitHub Actions.
- **Application agent** (form filling, submission) is not implemented; `applications-service` tracks lifecycle only.
- Several web dashboard pages render `UnderConstruction`.

## Deploy note

`api/*/index.js` are committed esbuild bundles. Re-run `node scripts/bundle-backend.mjs` and commit the result whenever a service or a `packages/*` dependency changes.

## Suggested next steps

1. Add a Postgres service to CI so the DB-backed suites run (cheapest large gain in confidence).
2. `admin-service` for university/enterprise (priority 5), starting with org-scoped read endpoints over `students` and applications.
3. Shared-store rate limiting and the missing observability pieces (priority 6).
