# 9. Security Model

## Controls
- RBAC
- MFA
- encryption at rest and in transit
- audit logs
- rate limiting
- anomaly detection

## Token handling
- Encrypt OAuth tokens with KMS-backed envelope encryption.
- Rotate refresh tokens when connectors support it.
- Scope tokens to the minimum required permissions.
- Separate user tokens from organization tokens.

## Data protection
- Classify resumes, cover letters, emails, and CRM exports as sensitive.
- Redact secrets from logs.
- Mask tokens and email addresses in observability pipelines when possible.

## Abuse prevention
- Apply per-user and per-org rate limits.
- Detect unusual automation bursts.
- Flag repeated failed submissions.
- Require step-up authentication for risky actions.

## Compliance posture
- Design for auditability from day one.
- Keep consent records for every connected service.
- Support data export and deletion workflows.
