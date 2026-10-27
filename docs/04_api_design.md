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
**Atlas does not submit applications for the user.** Greenhouse and Lever only accept an application with a key that belongs to the *employer*, so the user applies on the employer's own page and records the outcome here. Requires an `Idempotency-Key` header (8 to 200 characters).

Request:
```json
{ "job_id": "uuid", "resume_id": "uuid", "mode": "manual" }
```
`mode` is `manual` (default) or `review`; both start an editable `draft`. `"mode": "auto"` answers `400 VALIDATION_ERROR` unless the service runs with `APPLICATIONS_AUTO_MODE_ENABLED=true`, because no submission worker exists. The owner's response carries a `job` summary (title, company name, `apply_url`) so a client can open the employer's page.

### GET /v1/applications
The caller's applications, newest first (`limit`, `cursor`). `job_id` narrows the list to one job (not allowed together with `scope=organization`).

### POST /v1/applications/{id}/events
Moves an application along its lifecycle (`draft` to `submitted`, and onwards). While the application is still a `draft`, the owner can record that they opened the employer's apply link by sending `to_status: "draft"` with `note: "opened_apply_link"` (no status change).

## Outreach (outreach-service)
**Atlas does not deliver email.** No transport that really delivers exists (`local` only logs, `smtp` is not implemented), so by default a user sends a draft themselves and tells Atlas they did. `POST .../send` and `POST .../schedule` are switched off unless `OUTREACH_DELIVERY_ENABLED=true` (see below). Every endpoint needs a bearer token and is scoped to the caller: another user's message answers `404 NOT_FOUND`, the same as one that does not exist. Every message response has the shape `{ "message": { ... } }`.

### POST /v1/messages
Creates a draft. Requires an `Idempotency-Key` header (8 to 200 characters); repeating the call with the same key and the same request returns the existing draft with `200` instead of `201`, and reusing the key for a different request is `409 IDEMPOTENCY_KEY_REUSED`.

Request (at least one of `application_id` or `contact_id`; `subject` and `body` are drafted from the application and contact when omitted):
```json
{ "application_id": "uuid", "contact_id": "uuid", "channel": "email", "subject": "optional", "body": "optional" }
```

### GET /v1/messages and GET /v1/messages/{id}
List the caller's messages, newest first (`limit` 1 to 100, default 20, and `cursor`; response `{ "items": [], "next_cursor": null }`), or fetch one.

### POST /v1/messages/{id}/mark-sent
The user records that **they sent the message themselves** (copied it, or opened it in their own email app). Atlas delivers nothing and never calls a transport. It works whether or not delivery is enabled.

Request: no body, or optionally
```json
{ "note": "up to 500 characters" }
```

- `draft` or `scheduled` becomes `sent`, with `sent_at` set to the time it was recorded. The check and the change are one conditional `UPDATE`, so of any number of simultaneous requests exactly one makes the change and publishes the event.
- Repeating the call on a message that is already `sent` is `200` with the message as it is: no change and no second event.
- Any other status (`failed`, `delivered`, `replied`, `bounced`) is `409 CONFLICT`. Someone else's or a missing message is `404`.
- Publishes `outreach.sent` (the same payload `send` publishes). Its `event_id` is derived from the message id, so there is at most one such event per message. If the event cannot be published the call fails (`500`) and the message is put back to its earlier status, so a retry starts clean; the put-back is a best effort and is logged as an error if it too fails.
- Counts against the global rate limit only; it is not held to the stricter `send` limit.

Limitations, because the `messages` table has no column for either: **`note` is accepted but not stored** (nor echoed, nor logged), and **nothing marks a `sent` row as self-reported** as opposed to sent by Atlas. While delivery is off, which is the only supported production configuration, every `sent` row is self-reported; tell the two apart before turning delivery on by adding a column (a migration). `outreach.sent` carries no such marker either.

### POST /v1/messages/{id}/send and POST /v1/messages/{id}/schedule
Only available when `OUTREACH_DELIVERY_ENABLED=true`, which is off by default. While it is off both are refused with `503 UPSTREAM_UNAVAILABLE` after authentication and before anything else: nothing is read, claimed or written, no transport is called and no event is published.
```json
{
  "error": {
    "code": "UPSTREAM_UNAVAILABLE",
    "message": "Atlas does not deliver messages yet. Copy the draft or open it in your own email app, then record it with POST /v1/messages/:id/mark-sent.",
    "request_id": "uuid",
    "details": { "reason": "delivery_disabled", "alternative": "POST /v1/messages/:id/mark-sent" }
  }
}
```
Turning the flag on needs a transport that really delivers, and none exists yet, so leave it off. It accepts only a boolean word (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`); anything else, a typo included, stops the service at boot. With `NODE_ENV=production` it also refuses to start with `OUTREACH_DELIVERY_ENABLED=true` and `OUTREACH_TRANSPORT_DRIVER=local`. With the flag on (local development and tests):

- `send` atomically claims a `draft`, `scheduled` or `failed` message as `sent`, calls the transport (the `local` one only logs), reverts to `failed` if the transport throws, and publishes `outreach.sent`. A message in any other status is `400 VALIDATION_ERROR`. It has its own limit of 20 requests per minute per client address.
- `schedule` (`{ "scheduled_for": "<future ISO 8601>" }`) moves a `draft` to `scheduled`. **Nothing sends scheduled messages**: there is no worker, so this only stores a time.

### Job catalog: automatic ingestion from public job boards
The catalog fills from the public job-board endpoints that employers publish for embedding in their own careers pages. Read-only, no HTML scraping, no API keys; every request carries `User-Agent: AtlasJobIngest/1.0 (+read-only public job board reader[; contact: $JOB_SOURCE_CONTACT])`.

| Provider | Endpoint read | Official documentation |
|---|---|---|
| `greenhouse` | `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true` | https://docs.greenhouse.io/job-board.html#list-jobs |
| `lever` | `GET https://api.lever.co/v0/postings/{company}?mode=json` | https://github.com/lever/postings-api |
| `ashby` | `GET https://api.ashbyhq.com/posting-api/job-board/{name}` | https://developers.ashbyhq.com/docs/public-job-posting-api |

The boards to read are rows of `job_sources` (`provider`, `board_token`, `company_name`, `enabled`, plus `last_fetched_at`, `last_status`, `last_error`, `last_job_count`). A request URL is always the provider's fixed host plus the stored token, and a token may only contain letters, digits, `-` and `_` (enforced by the API, by a database CHECK constraint, and again just before the request), so a source cannot be pointed at another host. Redirects are refused.

#### GET|POST /internal/jobs/ingest-sources
Reads the enabled sources, least recently read first, and stores their postings. Called hourly by `.github/workflows/ingest-jobs.yml`, which does nothing until its `ATLAS_API_BASE_URL` (or `ATLAS_JOBS_URL`) variable and `CRON_SECRET` secret exist; it can also be run by hand (`workflow_dispatch`) or with a plain `curl`.

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

Postings a source no longer lists are marked inactive (`is_active = false`), never deleted, and come back if the source lists them again. Inactive jobs drop out of `GET /v1/jobs` (which lists active jobs unless asked otherwise), out of `GET /v1/jobs/recommendations`, out of matching, and cannot be applied to. Only jobs that source's provider created for that source's company are considered, judged by `last_seen_at` against the database clock. Nothing is deactivated when:
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
