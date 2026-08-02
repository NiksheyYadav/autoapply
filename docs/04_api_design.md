# 4. API Design

## API styles
- REST for public and operational endpoints
- GraphQL for dashboard aggregation
- WebSocket for live application and interview updates

## REST examples
### POST /v1/resumes
Request:
```json
{ "file_id": "uuid", "source": "upload" }
```
Response:
```json
{ "resume_id": "uuid", "status": "processing" }
```

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
