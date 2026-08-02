# 7. Deployment Architecture

## Runtime
- Docker for packaging
- Kubernetes for orchestration
- Cloudflare for edge protection and routing
- AWS for compute, storage, and managed services

## Environments
- local
- dev
- staging
- production

## Deployment flow
1. CI builds and tests each service.
2. Container images are scanned and signed.
3. Migrations run in controlled jobs.
4. Services deploy with health checks and canary rollout.
5. Telemetry confirms the release.
6. Rollback is automated on error thresholds.

## Suggested AWS components
- EKS
- RDS PostgreSQL
- ElastiCache Redis
- S3
- OpenSearch or vector DB service
- CloudWatch for infrastructure logs if needed

## Cloudflare
- WAF
- rate limiting
- bot protection
- edge caching for public assets
