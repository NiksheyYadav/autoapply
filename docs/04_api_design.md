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
