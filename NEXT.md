# NEXT

Working list for the autonomous stretch that started 2026-10-31. Most valuable first.

**Goal for this stretch:** break the project locally, find real defects, fix them, and record what held, so
the 2026-11-17 launch (individuals plus one university pilot) rests on tested behaviour. The brief that
describes the attack areas (A to G) lives outside the repo; each task below names its area.

**Ground rules for this stretch**
- Local only: tests and scripts run against a private Postgres (`atlas_integ`) and in-process Fastify apps. Nothing is run against Vercel, Supabase or any live system.
- No secrets or `.env` files touched. No new dependencies unless a task says why.
- Work happens on `work/<name>` branches cut from `claude/blissful-darwin-2n33wv` (the unmerged launch branch). Nothing is committed to `main`, nothing is merged.
- A task that needs a decision goes under "Needs Nikshey" and is skipped.
- Checks per task: `pnpm typecheck`, `npx eslint . --ignore-pattern '.claude/worktrees/**'`, and the affected tests (`ATLAS_TEST_DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas_integ npx vitest run <paths>`). `node scripts/bundle-backend.mjs` when service or package sources change.

## Queue

3. [ ] **Env boot fuzz, rest of it (F).** Done: `RATE_LIMIT_*`, `CORS_ORIGINS`. Still to do: `PLATFORM_ADMIN_USER_IDS` oddities, `SUPABASE_URL` (http, localhost, userinfo), `MESSAGING_DRIVER=memory` on serverless, `STORAGE_DRIVER` combinations, `.env.example` against the env schemas.
4. [ ] **Authorization matrix, runtime part (A).** Token forgery and the ownership checks were attacked and read (see Done). Still to do: run every route against anonymous, other user, other org staff, same-org roles and platform admin as a table-driven test, and mass assignment (extra keys such as `user_id`, `organization_id`, `role`, `status`) on every create and update body; RLS as the `anon`/`authenticated` roles on every table.
5. [ ] **Validation and pagination fuzz (B).** Malformed JSON, wrong types, oversized bodies, huge `limit` and `offset`, odd UUIDs. Always a clean 4xx envelope, never 500.
7. [ ] **ReDoS audit, rest of it (D).** `packages/ai` is done (see Done). Still to do: regexes in `services/profile/src` (text extraction clean-up), `services/admin` (CSV import), `packages/utils`, and the web apps' client-side parsing.
8. [ ] **Upload parsers, rest of it (D).** DOCX guards and the PDF stream bomb are done. Still to do: filenames (traversal, NUL, 10k characters) and multipart edge cases (no boundary, duplicate fields, many parts); a wall-clock limit on PDF text extraction (pdf.js can also be slow without being large).
9. [ ] **Races, rest of it (C).** Applications are done (see Done). Still to do: double drains (each event's effects applied once), double account deletion and deletion during activity, parallel roster imports, concurrent job ingest of the same posting, and `setScheduled` in outreach (unconditional update; only matters if delivery is ever enabled).
10. [ ] **Committed bundles end to end (G).** Boot `api/*/index.js` locally with a fake JWKS issuer, check `scripts/bundle-backend.mjs` is byte-for-byte repeatable.
11. [ ] **Secrets and logging hygiene (F).** Secret-like strings in tree, history and bundles; log redaction; log injection.
12. [ ] **Frontends with hostile data (E).** Web and admin rendering with script-like and oversized data, open-redirect params, CSV formula safety, security headers.

## Done

- [x] **Rate limiter vs real client IP (F)** — `work/break-fix-1`. Found and fixed: a bad `RATE_LIMIT_WINDOW` booted and then 500'd every request, or silently disabled limiting. Checked and held: store is a bounded LRU, exempt routes are by scope not path. Spoofable `X-Forwarded-For` is safe on Vercel (it overwrites the header); noted in `docs/17_break_report.md`. Typecheck, lint, full suite (119 files, 1,730 tests) pass; bundles rebuilt.
- [x] **Internal routes and rewrites (A/F)** — `work/break-fix-1`. Held. Added `packages/utils/test/vercel-routing.test.ts`, which fails if a public route stops resolving to its own function.
- [x] **Env boot fuzz, first half (F)** — `work/break-fix-1`. `CORS_ORIGINS` entries that can never match now stop the boot (trailing slash is forgiven). Rate-limit window done earlier.
- [x] **Token forgery and ownership checks (A)** — `work/break-fix-1`. 13 forgery vectors held. Fixed: a Supabase key-set outage answered 401 (the web app then signs everyone out), now 503; tokens without `exp` were accepted, now refused. New `packages/auth-kit/test/tokens-attacks.test.ts`. Suite: 122 files, 1,783 tests.
- [x] **Job-source fetchers and hostile postings (D)** — `work/break-fix-1`. SSRF, redirect, size and time limits all held. Fixed: a NUL byte in a posting made it unstorable, which also blocked the board's closed-role cleanup; control and bidi characters are now stripped. Suite: 123 files, 1,785 tests.
- [x] **ReDoS audit of `packages/ai` (D)** — `work/break-fix-1`. Found a real one: the resume email pattern was quadratic, so a 200 KB one-word text upload pinned a function for minutes. Fixed by bounding the pattern; new growth test over 37 hostile shapes. Suite: 124 files, 1,901 tests.
- [x] **PDF decompression bombs (D)** — `work/break-fix-1`. A 299 KB PDF cost 3 s and ~670 MB, and the size limit allows ~1 GB inflated. Added a capped pre-inflate of every stream (32 MB each, 128 MB total), 413 on excess. Suite: 124 files, 1,907 tests.
- [x] **Races in applications (C)** — `work/break-fix-1`. Real bugs: status moves could be applied twice, `submitted` published repeatedly, and a rejected application could become `offer`; identical simultaneous creates sometimes got a 409. Fixed with a conditional update and replay handling. Suite: 125 files, 1,912 tests.

## Blocked

(nothing yet)

## Needs Nikshey

- [ ] **Goal line was blank.** The goal in your message was still the placeholder text. I assumed "break the project locally, fix what I find, get ready for the 2026-11-17 launch". Tell me if you want a different focus.
- [ ] **Google Fonts at build time.** `next/font/google` made the admin build fail once in CI. The fix is to ship the font files with the repo (`next/font/local`) or use a system font stack. That changes how the site looks or adds font files, so it is your call.
- [ ] **`CORS_ORIGINS=*` in production.** `docs/16` says never, but nothing enforces it. Enforcing it would stop a service from starting if your Vercel settings use `*` today (for example on previews). Tell me whether to enforce it, or whether `*` is fine on previews and only production should refuse it.
- [ ] **Pushing branches.** Every push of any branch builds twelve Vercel projects and the free plan allows 100 deployments a day. I will commit locally and push only at clean points, in batches. Say if you want a different rhythm.
