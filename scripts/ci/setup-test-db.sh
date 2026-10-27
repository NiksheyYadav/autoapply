#!/usr/bin/env bash
#
# Prepare a throwaway Postgres for the DB-backed integration tests. CI and
# developers run the same commands, so "works on my machine" and "passes in CI"
# mean the same thing.
#
#   DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas_test \
#     scripts/ci/setup-test-db.sh
#   ATLAS_TEST_DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas_test pnpm test
#
# Requirements: a reachable Postgres 16+ with the pgvector extension available,
# a superuser connection (extensions and roles are created), `psql` and `pnpm`
# on PATH, and dependencies installed (`pnpm install`). The database itself must
# already exist (the CI service container and docker-compose create it).
#
# What it does, in order (all steps are idempotent, so re-running is safe):
#   1. infra/ci/supabase-stub.sql      roles + auth.users stand-in
#   2. pnpm db:migrate                 extensions + Drizzle migrations
#   3. packages/db/supabase/auth-hooks.sql   FK + handle_new_user trigger + hook
#   4. packages/db/supabase/rls.sql    RLS on every public table, no privileges for
#                                      anon/authenticated (production's Data API posture)
#
# CI/test databases only. Step 1 refuses to run on a real Supabase database,
# but point DATABASE_URL at a scratch database anyway, never at one you care
# about: the tests insert and delete rows.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "setup-test-db: DATABASE_URL is required, e.g." >&2
  echo "  DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas_test $0" >&2
  exit 1
fi

for tool in psql pnpm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "setup-test-db: '$tool' not found on PATH" >&2
    exit 1
  fi
done

# Show where we are about to write, with any password masked.
redacted_url="$(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:/@]*):[^@]*@#\1:***@#')"
echo "setup-test-db: target ${redacted_url}"

# Idempotent re-runs emit a NOTICE per "already exists, skipping"; keep real
# warnings and errors, drop that noise from the log.
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

# -X: ignore ~/.psqlrc so behaviour is identical everywhere. ON_ERROR_STOP makes
# any SQL error fail the script instead of being printed and skipped.
run_psql() {
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"
}

echo "==> [1/4] Supabase stand-in (roles, auth.users)"
run_psql -f infra/ci/supabase-stub.sql

echo "==> [2/4] Migrations (extensions + Drizzle)"
# migrate.ts reads DATABASE_URL from the environment, which is already set.
pnpm db:migrate

echo "==> [3/4] Auth hooks (users FK, handle_new_user trigger, access-token hook)"
# auth-hooks.sql does a plain `add constraint users_user_id_fkey`, which fails
# on a second run. Dropping it first makes this step re-runnable; the rest of
# the file is create-or-replace / drop-and-create already.
run_psql -c 'alter table public.users drop constraint if exists users_user_id_fkey'
run_psql -f packages/db/supabase/auth-hooks.sql

echo "==> [4/4] Row Level Security (RLS on public tables, no anon/authenticated grants)"
# Idempotent, and last so it sees every table the earlier steps created. The test
# suites connect as a superuser and are unaffected by RLS; this makes the database
# match production's Data API posture instead of leaving it wide open.
run_psql -f packages/db/supabase/rls.sql

echo "setup-test-db: done. Run the suites with:"
echo "  ATLAS_TEST_DATABASE_URL=<same url> pnpm test"
