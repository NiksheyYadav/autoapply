# 16. Launch Checklist (owner actions)

Everything in this file is something only the project owner can do (it needs
an account, a secret, a legal decision or a dashboard click), or a manual check
after a deploy. Code-side work is tracked in `docs/15_progress.md`.

Target: **2026-11-17**, individuals plus one university pilot.

## 0. Product decisions already taken (and what they mean)

| Decision | Consequence in the product |
|----------|---------------------------|
| **Assisted apply is the launch model (confirmed by the owner, 2026-10-29).** Greenhouse's application endpoint needs the *employer's* Job Board API key, and Lever's apply API needs a key that a Super Admin of the *employer's* account generates. A candidate-side platform has neither, and driving employers' public forms with a browser bot breaks their terms and trips CAPTCHAs. | `POST /v1/applications` accepts `mode: "manual"` only; `mode: "auto"` answers 400 unless `APPLICATIONS_AUTO_MODE_ENABLED=true` (leave it unset). The UI opens the employer's page and lets the user mark the application as submitted. Automatic submission stays switched off: it needs (a) an ATS API key supplied by the employer or a partner, held in the connectors service with per-tenant token isolation, and (b) a submission worker that consumes `queued` applications. Neither exists, so enabling the flag today would only park applications in `queued`. |
| **No fake email sending.** There is no email provider, so Atlas must not say a message was sent. | Outreach is drafts only (copy, open in the user's mail app, "I sent this"). `OUTREACH_DELIVERY_ENABLED` stays unset. Real delivery needs a provider, a sending domain (SPF/DKIM/DMARC), unsubscribe and consent rules: a separate decision. |
| **Job catalog comes from public employer job boards.** The jobs service reads the public Greenhouse, Lever and Ashby board endpoints that employers publish for embedding, on a schedule. | The catalog is only as good as the boards you add (section 4). Candidates are always sent to the employer's own page to apply. |
| **Organizations are created by operators**, never from signup metadata (that was a privilege-escalation hole). | A university pilot org is created with SQL by you (section 4). Platform-wide actions (job ingestion, contacts, cross-tenant metrics) require your user id in `PLATFORM_ADMIN_USER_IDS`. |

## 1. Supabase

The project `atlas` was **paused** when last checked. A paused free-tier project
serves nothing and auth calls fail.

1. Restore the project (Dashboard -> project -> Restore). For a launch consider the
   Pro plan: free projects pause after a week of inactivity, and Pro adds daily
   backups and removes the tight auth-email limits.
2. Apply the database, **in this order**, against the production database:
   1. `DATABASE_URL=<production url> pnpm db:migrate` (Drizzle migrations; creates
      tables including the event outbox).
   2. `packages/db/supabase/auth-hooks.sql` in the SQL editor. **Re-apply it even if you
      applied an older copy**: `handle_new_user` no longer creates organizations or
      owners from signup metadata. The file is safe to re-run.
   3. `packages/db/supabase/rls.sql` in the SQL editor. It enables Row Level Security on
      every public table and removes `anon`/`authenticated` access, so the public
      publishable key cannot read resumes, messages or contacts through the Data API.
      Services are unaffected (they connect with a privileged role). Safe to re-run.
3. Use the **pooled** connection string (Supavisor, transaction mode, port 6543) as
   `DATABASE_URL` for the Vercel functions. The database client disables prepared
   statements, so this is supported.
4. Auth settings (Dashboard -> Authentication):
   - **Hooks**: enable the *Custom access token* hook and point it at
     `public.custom_access_token_hook` (this puts the organization and role into tokens).
   - **Email**: keep *Confirm email* on (the web app handles the "check your inbox"
     state). Configure **custom SMTP**; the built-in sender is limited to a handful of
     emails per hour and is not for production.
   - **URL configuration**: Site URL = the web app origin; add
     `<web origin>/auth/callback` (and `/reset-password` if you use it as a redirect) to
     the redirect allow-list. Password-reset and confirmation links return through
     `/auth/callback`.
   - OAuth providers (Google / Microsoft / GitHub) only if you want them at launch; each
     needs its own client id and secret and the callback
     `https://<project-ref>.supabase.co/auth/v1/callback`.
5. Storage: create a **private** bucket (default name `resumes`).
6. Keep the *secret* API key (`sb_secret_...`, or the legacy `service_role` key) out of the
   repo and out of any `NEXT_PUBLIC_*` variable. It is used only by the profile service
   for storage (section 2).

## 2. Vercel

The repository supports **either** layout, and the code works with both:

- **One project** using the root `vercel.json` (committed `api/<service>/index.js`
  bundles plus public-path rewrites), or
- **One project per service** (the PR checks currently show seven `atlas-*` projects, each
  with Root Directory `services/<service>`).

Pick one and delete the other. Mixed deployments double the preview builds and make the
URLs ambiguous. The Vercel connector in this working session cannot see those projects
(it is authorized for a different scope), so I could not confirm which is live.

**Both layouts are connected at the same time.** The PR's deployment statuses list twelve
Vercel projects: `atlas-backend` (the single-project layout), `atlas-web` and `atlas-admin`,
and nine per-service projects (`atlas-auth`, `-profile`, `-jobs`, `-matching`,
`-applications`, `-referrals`, `-outreach`, `-learning`, `-analytics`). Every one of them
builds on every push, so the backend is built ten times over. Keep `atlas-backend`, `atlas-web`
and `atlas-admin`; disconnect the nine per-service projects.

**Why this is urgent:** on the free plan Vercel allows 100 deployments per day for the whole
team, and every push builds every connected project. Twelve projects means a single push is
twelve deployments, so about eight pushes use the day's allowance. During this work the PR already hit the limit:
the bot reported `Deployment rate limited ... api-deployments-free-per-day (more than 100)`
on `atlas-applications`, with "retry in 24 hours". Keeping only the three projects makes a push three deployments, and a paid plan raises the cap. Do this before
launch week, when you will be deploying often, and check Vercel's current terms for the
Hobby plan, which is meant for personal, non-commercial use, against a launch with a
university customer.

Environment variables (set per project; never commit values):

| Variable | Where | Notes |
|----------|-------|-------|
| `DATABASE_URL` | every backend service | pooled (port 6543) connection string |
| `SUPABASE_URL` | every backend service | `https://<ref>.supabase.co` |
| `CORS_ORIGINS` | every backend service | the web (and admin) origins, comma separated; never `*` in production |
| `CRON_SECRET` | matching, referrals, learning, analytics, **jobs** (job-board ingestion) | 16+ random characters; the same value goes in the GitHub secret below. Without it on `jobs`, scheduled ingestion answers 503 and the catalog never fills |
| `JOB_SOURCE_CONTACT` | jobs, optional | an email or URL appended to the job-board reader's `User-Agent`, so a board operator can reach you |
| `MESSAGING_DRIVER` | optional | defaults to `postgres` on Vercel; do not set `memory` |
| `PLATFORM_ADMIN_USER_IDS` | jobs, referrals, learning | comma-separated `auth.users` ids (yours). Empty means nobody |
| `STORAGE_DRIVER=supabase`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET` | profile **and auth** (account deletion removes the user's resume files) | without these, uploads fall back to ephemeral temp storage and the service logs a warning; deleting an account would then leave its files behind |
| `APPLICATIONS_AUTO_MODE_ENABLED` | applications | leave **unset** |
| `OUTREACH_DELIVERY_ENABLED` | outreach | leave **unset** |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL` | web, admin | publishable key only. The admin (university staff) console needs the same three plus `NEXT_PUBLIC_API_BASE_URL`, and its origin must be in `CORS_ORIGINS` |
| `NEXT_PUBLIC_API_BASE_URL` (single project) **or** `NEXT_PUBLIC_<SERVICE>_SERVICE_URL` (per service) | web, admin | |

Vercel Hobby cannot run sub-daily cron jobs and `vercel.json` deliberately has no `crons`
(adding them would fail the deployment). Event draining is scheduled from GitHub
Actions instead (section 3).

## 3. GitHub (Settings -> Secrets and variables -> Actions)

| Name | Type | Value |
|------|------|-------|
| `CRON_SECRET` | secret | the same value as on Vercel |
| `ATLAS_API_BASE_URL` | variable | single-project origin, no trailing slash |
| `ATLAS_MATCHING_URL`, `ATLAS_REFERRALS_URL`, `ATLAS_LEARNING_URL`, `ATLAS_ANALYTICS_URL` | variables | per-service origins (instead of `ATLAS_API_BASE_URL`) |
| `ATLAS_JOBS_URL` | variable | the jobs service's own origin, only if it is a separate project (job-board ingestion falls back to `ATLAS_API_BASE_URL`) |

`.github/workflows/drain-events.yml` runs every five minutes and `.github/workflows/ingest-jobs.yml`
reads the job boards every hour; both do nothing until these exist (the ingest workflow also
has a manual *Run workflow* button that takes an optional `source_id`, for trying one board). Without draining, events are queued but never delivered: no job scores, no
recommendations, no analytics. GitHub only runs `schedule` on the default branch, so
**merge to the default branch** for it to start, and it disables schedules after 60 days
without repository activity.

## 4. First data

1. Sign up through the web app, then copy your user id (`select id, email from auth.users;`)
   and set it as `PLATFORM_ADMIN_USER_IDS` on jobs, referrals and learning.
2. Create the pilot organization and its staff (SQL editor; `type` must be `university`,
   staff roles `admin` or `owner`):

   ```sql
   with org as (
     insert into public.organizations (name, type, slug)
     values ('Example University Career Services', 'university', 'example-university')
     returning organization_id
   )
   insert into public.organization_members (organization_id, user_id, role)
   select org.organization_id, u.user_id, 'owner'
   from org, public.users u
   where u.email = 'placement.officer@example.edu';
   ```

   The roster is **linked, not pre-created**: the `students` table needs a platform account,
   so the CSV import attaches each row to the account that has the same email
   (case-insensitive) and only *counts* rows that have no account yet
   (`noPlatformAccount` in the import result). The flow is therefore: students register
   with their institutional email first, then staff import the CSV, and staff re-import
   later to pick up students who registered afterwards (re-imports are idempotent).
   There is no invitation email; the university has to tell its students to sign up.
3. Job catalog. Add the employer boards to read, as a platform admin, with
   `POST /v1/jobs/sources` (`{"provider":"greenhouse","board_token":"figma","company_name":"Figma"}`;
   providers are `greenhouse`, `lever`, `ashby`) or by editing and running
   `packages/db/seed/job-sources.example.sql`. Trim the example first: the larger boards list
   several hundred postings each and the first fill of a big board can take more than one hourly
   run (it resumes). Then press *Run workflow* on **Ingest job sources** (or wait up to an hour)
   and check `GET /v1/jobs/sources` for each board's last status. Postings a board stops
   listing are deactivated and stop being recommended. `POST /v1/jobs/ingest` still works for
   one-off manual postings.

## 5. Legal and policy (owner / counsel, not code)

- Terms of Service: there is no Terms page. Registration should not go live without one.
- Privacy policy: `/privacy` exists as a static page; have it reviewed against what the
  product actually stores (resume text, parsed profile, application history, and for the
  university pilot the roster and funnel data staff can see).
- University pilot: a data-sharing agreement with the institution, a lawful basis for the
  roster import, and a decision on who is controller and who is processor. Student records
  are regulated in many jurisdictions (for example FERPA in the US, GDPR in the EU/UK).
- Account data: users can download everything held about them and delete their account
  (`/dashboard/settings`). Make sure the privacy policy says so, and confirm backup and log
  retention against what it promises.
- Outreach: if email delivery is ever added, consent, unsubscribe and anti-spam rules apply.
- Job data: ingestion uses the public board endpoints employers publish for embedding.
  Keep the attribution/apply-link behaviour (candidates are always sent to the employer's
  own page) and review each provider's terms before adding sources.

## 6. Verify after every deploy

```bash
ATLAS_API_BASE_URL=https://api.example.com \
ATLAS_WEB_URL=https://app.example.com \
CRON_SECRET=...           \
node scripts/smoke.mjs
```

It checks, without credentials and without writing anything: every backend function boots
and answers `401` from the service itself, the drain endpoints are protected (and run when
`CRON_SECRET` is supplied), the job-board ingest route is protected (probed without credentials
only, since a real call fetches third-party sites), the web pages render, and CORS allows the web origin. Per-service
layouts set `ATLAS_<SERVICE>_URL` instead. A `WARN` on a drain probe means `CRON_SECRET` is
not set on that service.

Then walk the product once by hand:

1. Register -> confirm email -> sign in. Request a password reset and complete it.
2. Upload a resume (PDF and DOCX) -> it reaches `parsed` with an ATS score.
3. A platform admin adds a job-board source (or ingests postings) and runs **Ingest job
   sources** -> within a few drain cycles the job matches page lists scored jobs, each with its
   employer, for that resume.
4. Open a job -> check the resume against it -> start an application -> open the employer
   page -> mark it submitted -> it appears on the applications page with the job title.
5. Outreach: open Messages, copy a draft, press *I sent this*; nothing is sent by Atlas.
6. Your data (`/dashboard/settings`): download the export; delete a throwaway account and check
   that signing in with it fails and its resume files are gone from the bucket.
7. University pilot: a student registers, staff imports a roster CSV containing that
   student's email (the import result shows it linked rather than `noPlatformAccount`), the
   funnel moves as the student applies, and the CSV export downloads. A signed-in user who is
   not a member of the organization gets 404.

## 7. Known risks to carry into launch week

- **Deployment quota**: see section 2. A burst of pushes can leave production undeployable
  for up to 24 hours on the free plan.
- **Rate limits are per function instance** (in-memory), so the effective ceiling scales with
  warm instances; there is no shared store yet.
- **Drain latency**: events are delivered at most every five minutes, so matches appear
  minutes after a resume upload, not instantly.
- **Account deletion is untested against real Supabase.** It runs `delete from auth.users` in
  one transaction through `DATABASE_URL`: the role needs DELETE on `auth.users`, and
  `storage.objects.owner` may block removing a user who owns files. Try it on a staging project
  before launch (see `docs/09_security_model.md`). Access tokens already issued stay valid until
  they expire, and there is no step-up re-authentication before deleting yet.
- **University staff can move students' applications.** Staff with the `admin`/`owner` role in the
  organization a student's application is filed under can append status events to it. Decide
  whether that is what the pilot agreement says.
- **Job data quality.** Boards change; a board that closes every role keeps its stale postings,
  description-only edits are not refreshed, and the Lever EU endpoint is not read.
- **No LLM is wired anywhere.** Matching, resume advice and drafting are deterministic
  heuristics; copy must not promise AI-written content.
- **Support and incident response**: no error-tracking vendor is configured; failures are in
  Vercel function logs only.
