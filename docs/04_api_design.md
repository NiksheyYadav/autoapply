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
