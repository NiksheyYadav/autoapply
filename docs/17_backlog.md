# 17 — Backlog

Ordered by priority. Autopilot takes the first `todo` item in Tier A, then Tier B. The owner can reorder, add, or cross out items at any time; edit this file directly.

Status values: `todo`, `in-progress`, `blocked`, `done`.

Evidence below comes from `docs/15_progress_report.md` and a baseline run on 2026-10-31 (typecheck clean, lint clean, 114 tests passed and 51 skipped, committed `api/` bundle current).

## Tier A — autopilot may implement

### A1 — Explain the test-count drop

Status: `todo`
`docs/15` records 125 passed / 55 skipped before the Supabase migration and 114 / 51 now, and says the drop "was not investigated separately".
Done when: the PR explains the difference with evidence from history. Any lost test that guarded real behavior is restored. Intentional removals are noted in `docs/15`.
History tip: the clone is shallow. Deepen with a bounded `git fetch --depth=1000 origin main`, not `--unshallow`.

### A2 — Retry and failure tests for `packages/messaging`

Status: `todo`
`packages/messaging` has no test files. `docs/13` says every queue consumer gets retry and failure tests.
Done when: tests cover publish and consume with the in-memory driver, a handler that throws, the retry behavior that exists, and what happens when retries run out. No network needed. If the code lacks behavior the principle expects, record the gap in the PR rather than inventing the behavior.

### A3 — SEO and AI-discoverability pass for `apps/web`

Status: `todo`
Goal: the public site leads with "Project Atlas" and is easy for search engines and LLMs to read.
Done when: page metadata and Open Graph tags, `robots.txt`, `sitemap.xml`, `llms.txt`, and JSON-LD (`SoftwareApplication`) are in place, and `pnpm --filter @atlas/web run build` passes with the CI env vars. Copy uses only facts from `docs/01_product_architecture.md`.

### A4 — Tests for `services/auth`

Status: `todo`
`services/auth` has no test files. It now only serves `GET /v1/auth/me` and `/health`, and `/me` does a fresh permissions lookup.
Done when: tests cover missing and invalid token, a valid token with a mocked permissions lookup, and `/health`. DB-backed variants may self-skip like the existing suites.

### A5 — Mocked-OAuth coverage for `services/connectors`

Status: `todo`
`docs/13`: every connector gets mocked OAuth tests.
Done when: the PR lists each connector, whether it has a mocked OAuth test, and adds the missing ones. Token isolation between connectors is asserted.

### A6 — API schema-validation tests, one service per run

Status: `todo`
`docs/13`: every public API gets schema validation tests.
Order: matching, applications, referrals, outreach, learning, analytics, jobs, profile. Each run takes the next service that has no validation tests for its public routes and marks it here.
Done so far: none.

### A7 — Options paper: where do the workers run?

Status: `todo`
Gap 1 in `docs/15`: event-driven workers need a persistent process and a real broker, and Vercel provides neither.
Done when: `docs/` has a short options paper comparing RabbitMQ plus a persistent worker host against cron-triggered polling endpoints, grounded in how the worker code is actually written, with costs, risks, and a clear "owner decision needed" ending. Docs only. It does not decide.

### A8 — Options paper: transactional outbox

Status: `todo`
Gap 2 in `docs/15`: a broker failure after the database commit loses the event permanently.
Done when: a docs-only options paper lists the routes affected, a schema sketch, the relay design, and migration impact, and ends with "owner decision needed".

### A9 — Bring `docs/09_security_model.md` in line with today's auth

Status: `todo`
The document still describes the pre-Supabase design.
Done when: it describes what exists now (Supabase Auth, JWKS verification through `@atlas/auth-kit`, `/me` permission lookup). Things not implemented, such as MFA, lockout, and platform-level admin, are marked as not implemented. It does not claim migration phase 6 is done.

## Tier B — prepare a PR, label it Unverified

### B1 — Run the DB-backed tests in CI

Status: `todo`
51 tests are skipped because no Postgres is wired into the CI job.
Done when: `.github/workflows/ci.yml` has a Postgres service and sets `ATLAS_TEST_DATABASE_URL`, and the PR reports what the skipped suites did on the PR's own CI run. The sandbox has no database, so the CI run is the only evidence. If suites need Supabase-specific SQL, say so and stop short of guessing.

### B2 — Platform-level admin role

Status: `todo`
Gap 3 in `docs/15`. Touches the permissions model, so the first PR is a short design note only. Implementation waits for the owner's go-ahead written under this item.

### B3 — Production drivers: storage `s3`, outreach `smtp`

Status: `todo`
Both throw "not implemented" today. Implement against mocked clients with unit tests, and label the PR Unverified because nothing here can reach real S3 or an SMTP server. Connectors `kms` is excluded because it needs a secrets-backend decision (Tier C).

## Tier C — owner only, never autopilot

- Supabase migration phase 6: dropping `password_hash`, `mfa_enabled`, `mfa_secret`, `failed_login_count`, `locked_until`. It is destructive on the live project, and `mfa_enabled` is part of the public API contract.
- Configuring Microsoft (`azure`) sign-in in Supabase.
- Exercising PDF upload on the deployed backend with a real resume.
- Deciding the worker-hosting question and whether to build the outbox (A7 and A8 only prepare the decision).
- Rotating the Supabase database credential; deleting the nine superseded Vercel projects; providing RabbitMQ, SMTP credentials, and a secrets backend.
- Kubernetes manifests, Dockerfiles, OpenTelemetry tracing, MFA, anomaly detection. These were deliberately not attempted because they cannot be verified in the sandbox.
- Billing (out of scope).
