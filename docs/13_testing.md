# 13. Testing Strategy

## Test layers
- unit tests for business logic
- integration tests for services and DB
- contract tests for APIs
- end-to-end tests for core workflows
- load tests for search, queues, and dashboards
- security tests for auth and connectors

## Critical scenarios
- resume upload
- job ingestion and dedupe
- application submission
- connector failure retry
- referral discovery
- analytics export

## Principles
- Every queue consumer gets retry and failure tests.
- Every connector gets mocked OAuth tests.
- Every public API gets schema validation tests.
