# 6. Queue Architecture

## Queue roles
- Kafka: durable event backbone for system events and analytics
- RabbitMQ: worker jobs, retries, connector tasks, user-facing background work
- Redis: lightweight locks, rate limiting, ephemeral job state

## Event types
- resume.parsed
- job.discovered
- job.scored
- application.created
- application.submitted
- outreach.sent
- referral.detected
- learning.updated

## Processing rules
- All external side effects must be idempotent.
- Use dead-letter queues for repeated failures.
- Tag every message with trace_id, organization_id, user_id, and correlation_id.
- Retry transient connector failures with backoff and jitter.

## Worker layout
- ingestion workers
- enrichment workers
- matching workers
- submission workers
- outreach workers
- analytics workers
