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

3. [ ] **Env boot fuzz, last part (F).** Done: rate limit, CORS, `SUPABASE_URL`, `CRON_SECRET`, `MESSAGING_DRIVER` on Vercel, `.env.example` drift. Still to do: `STORAGE_DRIVER` combinations (supabase needs URL, key and bucket; local driver on serverless), `DATABASE_URL` oddities (pooler/prepared statements), and a per-service boot with every variable blank.
4. [ ] **Authorization matrix, runtime part (A).** Token forgery and the ownership checks were attacked and read (see Done). Still to do: run every route against anonymous, other user, other org staff, same-org roles and platform admin as a table-driven test, and mass assignment (extra keys such as `user_id`, `organization_id`, `role`, `status`) on every create and update body; RLS as the `anon`/`authenticated` roles on every table.
5. [ ] **Validation fuzz, rest of it (B).** Cursors are done (see Done). Still to do: malformed JSON bodies, wrong types and oversized bodies on every POST, `__proto__` keys, odd UUIDs in paths and query filters (`location=%`, `remote_type`), duplicate query keys (`?limit=1&limit=2`), content-type mismatches, and the error envelope for each.
7. [ ] **ReDoS audit, rest of it (D).** `packages/ai` is done (see Done). Still to do: regexes in `services/profile/src` (text extraction clean-up), `services/admin` (CSV import), `packages/utils`, and the web apps' client-side parsing.
8. [ ] **Upload parsers, rest of it (D).** DOCX guards and the PDF stream bomb are done. Still to do: filenames (traversal, NUL, 10k characters) and multipart edge cases (no boundary, duplicate fields, many parts); a wall-clock limit on PDF text extraction (pdf.js can also be slow without being large).
9. [ ] **Races, rest of it (C).** Applications are done (see Done). Still to do: double drains (each event's effects applied once), double account deletion and deletion during activity, parallel roster imports, concurrent job ingest of the same posting, and `setScheduled` in outreach (unconditional update; only matters if delivery is ever enabled).
10. [ ] **Committed bundles, more flows (G).** The first end-to-end run is done (see Done). Still to do: the drain routes with a real outbox backlog through the bundles, the admin roster import through the admin bundle, deletion through the auth bundle, and a clean-room `pnpm install --frozen-lockfile` + bundle + run from a fresh clone.
11. [ ] **Secrets and logging hygiene (F).** Secret-like strings in tree, history and bundles; log redaction; log injection.
12. [ ] **Frontends in a browser (E).** Static review, redirect, link and header checks are done (see Done). Still to do: Playwright against a fake API with script-like, oversized, RTL and null data on every page, API down / 500 / 429 / malformed JSON on every page, double submit on mutating buttons, and a Content-Security-Policy with nonces.

## Done

- [x] **Rate limiter vs real client IP (F)** — `work/break-fix-1`. Found and fixed: a bad `RATE_LIMIT_WINDOW` booted and then 500'd every request, or silently disabled limiting. Checked and held: store is a bounded LRU, exempt routes are by scope not path. Spoofable `X-Forwarded-For` is safe on Vercel (it overwrites the header); noted in `docs/17_break_report.md`. Typecheck, lint, full suite (119 files, 1,730 tests) pass; bundles rebuilt.
- [x] **Internal routes and rewrites (A/F)** — `work/break-fix-1`. Held. Added `packages/utils/test/vercel-routing.test.ts`, which fails if a public route stops resolving to its own function.
- [x] **Env boot fuzz, first half (F)** — `work/break-fix-1`. `CORS_ORIGINS` entries that can never match now stop the boot (trailing slash is forgiven). Rate-limit window done earlier.
- [x] **Token forgery and ownership checks (A)** — `work/break-fix-1`. 13 forgery vectors held. Fixed: a Supabase key-set outage answered 401 (the web app then signs everyone out), now 503; tokens without `exp` were accepted, now refused. New `packages/auth-kit/test/tokens-attacks.test.ts`. Suite: 122 files, 1,783 tests.
- [x] **Job-source fetchers and hostile postings (D)** — `work/break-fix-1`. SSRF, redirect, size and time limits all held. Fixed: a NUL byte in a posting made it unstorable, which also blocked the board's closed-role cleanup; control and bidi characters are now stripped. Suite: 123 files, 1,785 tests.
- [x] **ReDoS audit of `packages/ai` (D)** — `work/break-fix-1`. Found a real one: the resume email pattern was quadratic, so a 200 KB one-word text upload pinned a function for minutes. Fixed by bounding the pattern; new growth test over 37 hostile shapes. Suite: 124 files, 1,901 tests.
- [x] **PDF decompression bombs (D)** — `work/break-fix-1`. A 299 KB PDF cost 3 s and ~670 MB, and the size limit allows ~1 GB inflated. Added a capped pre-inflate of every stream (32 MB each, 128 MB total), 413 on excess. Suite: 124 files, 1,907 tests.
- [x] **Races in applications (C)** — `work/break-fix-1`. Real bugs: status moves could be applied twice, `submitted` published repeatedly, and a rejected application could become `offer`; identical simultaneous creates sometimes got a 409. Fixed with a conditional update and replay handling. Suite: 125 files, 1,912 tests.
- [x] **Forged pagination cursors (B)** — `work/break-fix-1`. A cursor with a bad timestamp or id gave a 500 on six list endpoints; other bad shapes were silently the first page. One shared validator, 400 for anything not issued by the API. Also: six simultaneous account deletions hold. Suite: 126 files, 1,961 tests.
- [x] **Config that starts fine and then breaks (F)** — `work/break-fix-1`. `SUPABASE_URL` with a trailing slash refused every token; `MESSAGING_DRIVER=memory` (the `.env.example` value) would drop events on Vercel; `CRON_SECRET` with a pasted newline could never match. All now normalized or refused at boot. `.env.example` now lists every variable and a test keeps it so. Also: request body / query / path fuzz on applications held (76 cases). Suite: 130 files, 2,070 tests.
- [x] **Frontend headers and static review (E)** — `work/break-fix-1`. The web app sent no security headers; added framing protection, nosniff, referrer and permissions policies, hid `X-Powered-By`; admin tightened to match. Both apps build; headers checked on a running build. Suite: 132 files, 2,080 tests.
- [x] **Deployed bundles, end to end (G)** — `work/break-fix-1`. **Found a launch blocker:** PDF resumes could not be parsed in the deployed profile bundle (pdf.js could not find its worker file), though all source-level tests passed. Fixed with pdf-parse's embedded worker. New test boots all ten committed bundles over HTTP against Postgres. Suite: 133 files, 2,099 tests.

## Blocked

(nothing yet)

## Needs Nikshey

- [ ] **Goal line was blank.** The goal in your message was still the placeholder text. I assumed "break the project locally, fix what I find, get ready for the 2026-11-17 launch". Tell me if you want a different focus.
- [ ] **Google Fonts at build time.** `next/font/google` made the admin build fail once in CI. The fix is to ship the font files with the repo (`next/font/local`) or use a system font stack. That changes how the site looks or adds font files, so it is your call.
- [ ] **`CORS_ORIGINS=*` in production.** `docs/16` says never, but nothing enforces it. Enforcing it would stop a service from starting if your Vercel settings use `*` today (for example on previews). Tell me whether to enforce it, or whether `*` is fine on previews and only production should refuse it.
- [ ] **Check your live Vercel settings against four things.** (1) `SUPABASE_URL` should be the project origin; a trailing slash is now forgiven, but `http://` or a stray path is refused at boot. (2) `MESSAGING_DRIVER` is ignored if it is `memory` on Vercel. (3) `CRON_SECRET` must have no spaces inside. (4) `CORS_ORIGINS` entries must be `https://host` only (a trailing slash is forgiven). If any of these is wrong today, the matching service will now stop with a message naming the variable instead of starting and misbehaving.
- [ ] **Pushing branches.** Every push of any branch builds twelve Vercel projects and the free plan allows 100 deployments a day. I will commit locally and push only at clean points, in batches. Say if you want a different rhythm.
