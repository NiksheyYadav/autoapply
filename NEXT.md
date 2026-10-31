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
4. [ ] **Authorization matrix (A).** Every route of every service against anonymous, other user, other org staff, same org roles, platform admin. Mass assignment on create and update bodies.
5. [ ] **Validation and pagination fuzz (B).** Malformed JSON, wrong types, oversized bodies, huge `limit` and `offset`, odd UUIDs. Always a clean 4xx envelope, never 500.
6. [ ] **Job-source fetchers (D).** SSRF via board token and redirects, response size and time limits, hostile postings (script tags, `javascript:` apply links), cross-company overwrite.
7. [ ] **ReDoS audit (D).** Every regex in `packages/ai`, `services/profile/src`, `services/jobs/src` with adversarial 200 KB inputs.
8. [ ] **Upload parsers (D).** Hostile PDFs and DOCX (zip bombs, traversal names, truncation), filenames, multipart edge cases.
9. [ ] **Races and idempotency (C).** Parallel application creates, parallel status moves, double drains, double account deletion.
10. [ ] **Committed bundles end to end (G).** Boot `api/*/index.js` locally with a fake JWKS issuer, check `scripts/bundle-backend.mjs` is byte-for-byte repeatable.
11. [ ] **Secrets and logging hygiene (F).** Secret-like strings in tree, history and bundles; log redaction; log injection.
12. [ ] **Frontends with hostile data (E).** Web and admin rendering with script-like and oversized data, open-redirect params, CSV formula safety, security headers.

## Done

- [x] **Rate limiter vs real client IP (F)** — `work/break-fix-1`. Found and fixed: a bad `RATE_LIMIT_WINDOW` booted and then 500'd every request, or silently disabled limiting. Checked and held: store is a bounded LRU, exempt routes are by scope not path. Spoofable `X-Forwarded-For` is safe on Vercel (it overwrites the header); noted in `docs/17_break_report.md`. Typecheck, lint, full suite (119 files, 1,730 tests) pass; bundles rebuilt.
- [x] **Internal routes and rewrites (A/F)** — `work/break-fix-1`. Held. Added `packages/utils/test/vercel-routing.test.ts`, which fails if a public route stops resolving to its own function.
- [x] **Env boot fuzz, first half (F)** — `work/break-fix-1`. `CORS_ORIGINS` entries that can never match now stop the boot (trailing slash is forgiven). Rate-limit window done earlier.

## Blocked

(nothing yet)

## Needs Nikshey

- [ ] **Goal line was blank.** The goal in your message was still the placeholder text. I assumed "break the project locally, fix what I find, get ready for the 2026-11-17 launch". Tell me if you want a different focus.
- [ ] **Google Fonts at build time.** `next/font/google` made the admin build fail once in CI. The fix is to ship the font files with the repo (`next/font/local`) or use a system font stack. That changes how the site looks or adds font files, so it is your call.
- [ ] **`CORS_ORIGINS=*` in production.** `docs/16` says never, but nothing enforces it. Enforcing it would stop a service from starting if your Vercel settings use `*` today (for example on previews). Tell me whether to enforce it, or whether `*` is fine on previews and only production should refuse it.
- [ ] **Pushing branches.** Every push of any branch builds twelve Vercel projects and the free plan allows 100 deployments a day. I will commit locally and push only at clean points, in batches. Say if you want a different rhythm.
