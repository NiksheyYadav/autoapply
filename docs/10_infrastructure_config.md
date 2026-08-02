# 10. Infrastructure Configuration

## Core stack
- Next.js frontend
- FastAPI services
- Node.js microservices where useful
- PostgreSQL
- Redis
- vector database
- S3
- Kubernetes
- Prometheus
- Grafana
- OpenTelemetry

## Config layers
- app config
- environment config
- secrets config
- deployment config
- runtime policy config

## Secrets
- Use AWS Secrets Manager or an equivalent secret store.
- No secrets in env files committed to git.
- Rotate connector credentials regularly.

## Observability
- Emit structured JSON logs.
- Propagate trace IDs through every request.
- Export metrics for queue depth, job latency, connector failures, and AI token usage.

## Example config themes
- low-latency search index for jobs
- durable audit trail
- separate compute pools for ingestion and user-facing APIs
