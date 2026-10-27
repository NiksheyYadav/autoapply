-- Example job-board sources for the jobs catalog.
--
-- HOW TO APPLY: this is NOT a Drizzle migration and nothing runs it automatically.
-- Run it by hand (Supabase dashboard SQL editor as `postgres`, or psql with your
-- DATABASE_URL) after `pnpm db:migrate`. It is idempotent: ON CONFLICT DO NOTHING
-- leaves any source you already have untouched, so re-running it, or running it
-- after adding boards through POST /v1/jobs/sources, is safe.
--
-- WHAT THESE ARE: public, unauthenticated job-board endpoints that employers publish
-- for embedding in their own careers pages. The jobs service's scheduled ingestion
-- (/internal/jobs/ingest-sources, hourly via .github/workflows/ingest-jobs.yml) reads
-- the enabled rows here, least recently read first.
--   greenhouse  https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
--   lever       https://api.lever.co/v0/postings/{board_token}?mode=json
--   ashby       https://api.ashbyhq.com/posting-api/job-board/{board_token}
--
-- CHECKED: each token below returned a job list from its endpoint on 2026-10-27
-- (posting counts that day in the comments; they change daily). Boards come and go,
-- so a token that stops working simply shows last_status = 'error' in
-- GET /v1/jobs/sources; it does not affect the other rows.
--
-- COMPANY NAMES: postings are attributed to `company_name`, and one provider cannot have
-- two boards under the same name (POST /v1/jobs/sources refuses the pair; keep that
-- rule here too, because a board's vanished postings are retired per provider and company).
--
-- SIZE: the larger boards below list several hundred postings each, and the first read
-- of a big board can take more than one hourly run to finish (it resumes where it left
-- off). Trim this list to the employers you want in the catalog before running it.
--
-- To add your own, find the token in the employer's careers URL:
--   boards.greenhouse.io/{token}  or  job-boards.greenhouse.io/{token}
--   jobs.lever.co/{token}
--   jobs.ashbyhq.com/{token}
-- Tokens may contain only letters, digits, "-" and "_" (the table enforces it).

INSERT INTO job_sources (provider, board_token, company_name) VALUES
  ('greenhouse', 'anthropic',  'Anthropic'),   -- 679 postings
  ('greenhouse', 'stripe',     'Stripe'),      -- 713 postings
  ('greenhouse', 'figma',      'Figma'),       -- 141 postings
  ('lever',      'palantir',   'Palantir'),
  ('lever',      'spotify',    'Spotify'),
  ('ashby',      'ramp',       'Ramp'),        -- 173 postings
  ('ashby',      'notion',     'Notion'),      -- 140 postings
  ('ashby',      'ashby',      'Ashby')        --  66 postings
ON CONFLICT (provider, board_token) DO NOTHING;
