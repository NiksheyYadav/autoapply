# 1. Product Architecture Diagram

## System overview
Project Atlas is a multi-tenant AI job automation platform with three user groups:
- Individuals
- Universities / colleges
- Enterprise customers

## Logical layers
- Web app: Next.js + TypeScript + Tailwind + shadcn/ui + React Query + Framer Motion
- API gateway: REST + GraphQL + WebSocket
- Core services: auth, profiles, jobs, applications, referrals, outreach, analytics
- AI services: resume parsing, ranking, optimization, learning
- Async layer: Kafka for durable event streams, RabbitMQ for short-lived task queues
- Data layer: PostgreSQL, Redis, vector DB, S3
- Platform: Docker, Kubernetes, AWS, Cloudflare
- Observability: OpenTelemetry, Prometheus, Grafana

## Primary flow
1. User imports profile data.
2. Resume agent parses and normalizes profile.
3. Job discovery agent pulls jobs continuously.
4. Matching agent scores opportunities.
5. Resume optimization agent prepares ATS-friendly variants.
6. Application agent submits and tracks applications.
7. Referral and outreach agents target relevant humans.
8. Learning agent updates ranking models from outcomes.

## Architectural decisions
- Postgres is the system of record.
- Redis handles caching, rate limiting, and short-lived orchestration state.
- Vector DB stores embeddings for resumes, jobs, and contacts.
- S3 stores raw files and generated artifacts.
- Kafka handles events that must not be lost.
- RabbitMQ handles retryable worker jobs and connector tasks.
