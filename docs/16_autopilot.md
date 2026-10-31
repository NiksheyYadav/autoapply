# 16 — Autopilot

Rules for unattended Claude runs on this repository. A scheduled run starts with no memory of earlier runs, so everything it needs to know is in the repo: this file, `docs/17_backlog.md`, `docs/18_autopilot_log.md`, and `docs/15_progress_report.md`.

`CLAUDE.md` still applies. If this file and `CLAUDE.md` disagree, `CLAUDE.md` wins.

## Principle

Ship the smallest safe, verified change per run, as a pull request the owner can review in a few minutes. A run that ends with "blocked, here is why" is a good run. A run that ends with an unverified claim is a bad one.

## One run, in order

1. **Orient.** Read `CLAUDE.md`, this file, `docs/17_backlog.md`, `docs/18_autopilot_log.md`, and the "Known gaps" and "Next steps" sections of `docs/15_progress_report.md`. Run `pnpm install --frozen-lockfile`.
2. **Baseline.** On a clean `main`, run `pnpm typecheck`, `pnpm lint`, `pnpm test`. Record the passed and skipped counts. If anything is red, do no feature work: fix it only if the cause is clear and small, otherwise log it and stop.
3. **Open-PR gate.** List open pull requests with the REST API (`gh api repos/NiksheyYadav/autoapply/pulls`; GraphQL is blocked in these sessions). Count those whose head branch starts with `autopilot/`.
   - Two or more open: start no new item. Check each one's CI status and review comments, push fixes to that branch if needed, log it, and stop.
   - Fewer than two: continue.
4. **Pick one item.** Take the first backlog item in Tier A, then Tier B, whose status is `todo` and which no open `autopilot/` branch is already working on. One item per run. If it cannot finish in one run, finish the first coherent slice, set it to `in-progress`, and write what remains under it.
5. **Plan, build, review.** Use three separate subagents so the work never grades itself:
   - `AutopilotPlanner` returns a short plan: files, tests, acceptance check.
   - `AutopilotBuilder` implements it on branch `autopilot/<id>-<slug>`.
   - `AutopilotReviewer` has no write tools. It reads the diff, re-runs the checks itself, and answers PASS or FAIL with reasons. On FAIL the builder gets at most two fix rounds. After that, abandon the item, mark it `blocked` with the reason, and stop.
6. **Verify (all must hold).**
   - `pnpm typecheck` and `pnpm lint` are clean.
   - `pnpm test`: passed count is not lower than the baseline and skipped count is not higher, unless the item is explicitly about removing or unskipping tests.
   - If anything under `services/` or `packages/` changed, run `node scripts/bundle-backend.mjs` and commit the regenerated `api/`. Vercel reads functions from the git checkout, so a stale `api/` ships old code.
   - If `apps/web` or `apps/admin` changed, run that app's `typecheck` and `build` using the environment variables in `.github/workflows/ci.yml`.
7. **Ship.** Push the branch and open a pull request through the REST API. Update the item's status in `docs/17_backlog.md` and add an entry to `docs/18_autopilot_log.md` in the same pull request, so merging records the state. Never merge your own pull request.
8. **Report.** Send the owner a summary of at most five lines, in simple language (English or Hinglish, casual, no jargon): what shipped, the pull request link, what is blocked, and anything that needs an owner decision. The later run of each day (after 05:00 IST) starts the message with "Daily report:" and covers every run since midnight IST, using `docs/18_autopilot_log.md` and the list of open `autopilot/` pull requests.

## Pull request body

- What changed and why, tied to a backlog id.
- Evidence: the commands run and their results.
- What is **not** verified. Use the labels from `docs/15_progress_report.md`: Verified (with date), Last verified, Unverified.

## Never

- Push to `main`, force-push, rewrite history, merge a pull request, or delete a branch that does not start with `autopilot/`.
- Run a migration or any command against live Supabase, Vercel, or any production system. Do not deploy.
- Read, print, or commit secrets. Only `.env.example` may change, and only with placeholder values.
- Change an API contract (`packages/types`) unless the backlog item says to.
- Touch a Tier C item.
- Add a dependency unless the pull request explains why existing code or the standard library will not do. Keep the lockfile consistent.
- Write public-facing copy that states facts not found in `docs/`: no metrics, customers, certifications, or pricing.
- Claim something works without having run it.

## Budget

These runs draw on the owner's Claude usage limits, so they are deliberately small.

- **A run uses at most about half of one five-hour usage window.** A run cannot read the usage meter, so this is enforced by size: one item, targeted file reads only, and roughly 50 tool calls in total including the subagents' calls. If you reach that and are not done, stop at a clean point: commit only what is verified, mark the item `in-progress` with notes, and log it.
- The schedule is two runs a day, at 01:12 and 06:12 IST, five hours apart so each gets its own window. The owner should check Settings > Usage after the first few runs and tell Claude to tighten or loosen the size cap.
- One item per run. Stop early rather than expanding scope.
- If a usage limit interrupts a run, nothing is lost: progress lives on the branch and in the log. The next run resumes from there.
- The owner sets the cadence by editing the scheduled task. The agent never changes its own schedule.

## Tiers

- **Tier A** — safe to implement and verify inside the sandbox.
- **Tier B** — may be prepared as a pull request, but cannot be fully verified here. It must be labelled Unverified and is not "done" until CI is green and the owner reviews it.
- **Tier C** — owner only. Never done by autopilot. Autopilot may write a docs-only options paper to support the decision, if a Tier A item asks for one.
