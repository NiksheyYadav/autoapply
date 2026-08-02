# Project Atlas — working instructions

Build incrementally. Do not try to implement everything in one pass.

Priorities:
1. Establish the core platform architecture and repo structure.
2. Create the database schema and service boundaries.
3. Implement authentication, profile ingestion, and job discovery.
4. Add matching, resume optimization, applications, referrals, and outreach.
5. Add university and enterprise administration modules.
6. Add observability, security hardening, and deployment automation.

Rules:
- Prefer typed interfaces, explicit validation, and test coverage.
- Keep each service independently deployable.
- Treat connectors as optional integrations with strict OAuth/token isolation.
- Avoid storing secrets in code or prompts.
