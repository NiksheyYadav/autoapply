# 4. API Design

## API styles
- REST for public and operational endpoints
- GraphQL for dashboard aggregation
- WebSocket for live application and interview updates

## REST examples
### POST /v1/resumes
`multipart/form-data`: a `file` part (the resume) plus an optional `source` field (`upload` | `connector` | `import`, default `upload`).

Response:
```json
{ "resume_id": "uuid", "status": "parsed" }
```

### POST /v1/resumes/{resume_id}/optimize
Request:
```json
{ "job_id": "uuid" }
```

Response:
```json
{
  "resume_id": "uuid",
  "job_id": "uuid",
  "report": {
    "keyword_match": { "score": 67, "matched": ["typescript"], "missing": ["kubernetes"] },
    "bullet_findings": [],
    "ats": { "score": 85, "checks": [] },
    "recommendations": [],
    "truthfulness_note": "..."
  }
}
```

Advisory and stateless: it compares a parsed resume with one job and stores nothing. It never rewrites the resume or adds a skill or metric the candidate did not state. Returns `409 CONFLICT` if the resume has not parsed, and `404` for an unknown job or a resume the caller does not own.

### GET /v1/jobs/recommendations
Query params:
- user_id
- limit
- location
- remote_type

Response:
```json
{ "items": [], "next_cursor": null }
```

### POST /v1/applications
Request:
```json
{ "job_id": "uuid", "resume_id": "uuid", "mode": "auto" }
```

### Job catalog: automatic ingestion from public job boards
The catalog fills from the public job-board endpoints that employers publish for embedding in their own careers pages. Read-only, no HTML scraping, no API keys; every request carries `User-Agent: AtlasJobIngest/1.0 (+read-only public job board reader[; contact: $JOB_SOURCE_CONTACT])`.

| Provider | Endpoint read | Official documentation |
|---|---|---|
| `greenhouse` | `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true` | https://docs.greenhouse.io/job-board.html#list-jobs |
| `lever` | `GET https://api.lever.co/v0/postings/{company}?mode=json` | https://github.com/lever/postings-api |
| `ashby` | `GET https://api.ashbyhq.com/posting-api/job-board/{name}` | https://developers.ashbyhq.com/docs/public-job-posting-api |

The boards to read are rows of `job_sources` (`provider`, `board_token`, `company_name`, `enabled`, plus `last_fetched_at`, `last_status`, `last_error`, `last_job_count`). A request URL is always the provider's fixed host plus the stored token, and a token may only contain letters, digits, `-` and `_` (enforced by the API, by a database CHECK constraint, and again just before the request), so a source cannot be pointed at another host. Redirects are refused.

#### GET|POST /internal/jobs/ingest-sources
Reads the enabled sources, least recently read first, and stores their postings. Called hourly by `.github/workflows/ingest-jobs.yml` (or by hand with `workflow_dispatch`).

- `Authorization: Bearer $CRON_SECRET` (constant-time compare). `503 UPSTREAM_UNAVAILABLE` if `CRON_SECRET` is not set on the jobs service, `401` for a missing or wrong secret. Not rate limited, like the drain routes.
- Query: `limit` (boards per call, 1-200, default 50), `budget_ms` (100-25000, default 20000; functions are capped at 30s), `source_id` (read only this enabled source, e.g. straight after adding it).
- Three boards are read at once. A board is not started with under 1.5s of the budget left, and its fetch (10s at most, and never past the budget) covers the response body; responses over 25 MB are refused. A board that fails is recorded and skipped; the run carries on. Every attempt, failed or not, moves the board to the back of the line.

Response:
```json
{
  "sources_total": 8, "attempted": 8, "succeeded": 7, "failed": 1, "not_attempted": 0,
  "inserted": 12, "updated": 1, "duplicates": 1370, "rejected": 0, "deactivated": 4,
  "duration_ms": 6120,
  "sources": [
    {
      "source_id": "uuid", "provider": "greenhouse", "board_token": "figma", "status": "ok",
      "fetched": 141, "skipped": 0, "inserted": 3, "updated": 0, "duplicates": 138,
      "rejected": 0, "deactivated": 1, "deactivation_skipped": null,
      "duration_ms": 910, "error": null
    }
  ]
}
```
`status` is `ok`, `partial` (the budget ran out, or some postings could not be stored) or `error` (the board could not be read, or storing its postings hit a database failure; `error` is a short fixed sentence, never an upstream or database message). The same status, error and posting count are kept on the source row.

How postings are stored:
- Mapped to the same `RawJobPosting` as manual ingest and deduplicated by the same content hash (company, title, location, workplace type), so a role listed on two boards is one job. New jobs publish `job.discovered`.
- A posting the board edited (same external id, new title, location or workplace type) is rewritten in place and announced again so it is re-scored. An edit that leaves those three unchanged (for example, only the description) is not picked up for a job already stored.
- Salary is stored only where the source says it is annual (Lever `per-year-salary`). Greenhouse's list carries no salary, employment type or workplace type (the last two are read from custom fields when a board exposes them, and "Remote" from the location text). Ashby compensation is not requested. Ashby postings with `isListed: false` are skipped.

Postings a source no longer lists are marked inactive (`is_active = false`), never deleted, and come back if the source lists them again. Only jobs that source's provider created for that source's company are considered, judged by `last_seen_at` against the database clock. Nothing is deactivated when:
- the fetch failed, or the board returned an empty list (`deactivation_skipped: "empty_result"`; a company that really closed every opening therefore keeps its stale postings until they are removed another way);
- the run did not process every posting (`incomplete_run`) or some could not be stored (`rejected_postings`);
- the board lists under 20% of what it listed last time, from a board that listed at least 10 (`sharp_drop`). The new count is recorded, so if the next run sees the same thing the deactivation goes ahead one run late.

A very large board may need more than one run for its first fill (each run stores what it can inside the budget and the next picks up the rest).

#### GET /v1/jobs/sources
Platform administrators only (`PLATFORM_ADMIN_USER_IDS`; an org admin or owner role is not enough). `403 FORBIDDEN` otherwise.

Response:
```json
{ "items": [ { "source_id": "uuid", "provider": "greenhouse", "board_token": "figma", "company_name": "Figma", "enabled": true, "last_fetched_at": "2026-10-27T14:17:03.000Z", "last_status": "ok", "last_error": null, "last_job_count": 141, "created_at": "2026-10-27T13:00:00.000Z" } ] }
```

#### POST /v1/jobs/sources
Platform administrators only. Adds a source, or updates the one stored for that `provider` and `board_token`.

Request:
```json
{ "provider": "greenhouse", "board_token": "figma", "company_name": "Figma", "enabled": true }
```
`enabled` is optional: a new source starts enabled, an existing one keeps its state. Returns the source, `201` when created and `200` when updated. `400` for an unknown provider, a token outside the charset, or a blank or over-long name. `409 CONFLICT` if another board of the same provider already uses the company name (postings are retired per provider and company, so two such boards would retire each other's postings).

## Validation rules
- Use Pydantic / Zod schemas at all boundaries.
- Reject invalid connector payloads early.
- Require idempotency keys for application submission and outreach sending.

## Error model
```json
{
  "error": {
    "code": "JOB_NOT_FOUND",
    "message": "Job is unavailable",
    "request_id": "uuid"
  }
}
```

## GraphQL
Use GraphQL for:
- dashboards
- analytics summaries
- org-wide reports
- recruiter and student views

## WebSockets
Use WebSockets for:
- live application status
- queue progress
- interview reminders
- connector sync updates
