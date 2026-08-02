# 8. Microservice Architecture

## Services
- auth-service
- profile-service
- jobs-service
- matching-service
- applications-service
- referrals-service
- outreach-service
- learning-service
- connectors-service
- analytics-service
- admin-service

## Responsibility split
- auth-service handles login, MFA, RBAC, and sessions
- profile-service handles imports, parsing, and normalized user state
- jobs-service handles acquisition and deduplication
- matching-service handles scoring and ranking
- applications-service handles submission and lifecycle tracking
- referrals-service handles people discovery and graphs
- outreach-service handles email/message generation and scheduling
- learning-service handles outcome feedback loops
- connectors-service isolates external APIs and token handling
- analytics-service aggregates metrics and events
- admin-service handles college and enterprise operations

## Communication
- Synchronous calls for user-triggered reads
- Async events for cross-service workflows
- Never share databases across services
