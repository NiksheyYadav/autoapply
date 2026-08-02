# 3. Folder Structure

## Monorepo layout
```text
project-atlas/
  apps/
    web/
    admin/
  services/
    auth/
    profile/
    jobs/
    matching/
    applications/
    referrals/
    outreach/
    learning/
    connectors/
    analytics/
  packages/
    ui/
    types/
    config/
    db/
    ai/
    utils/
  infra/
    docker/
    kubernetes/
    terraform/
    cloudflare/
  docs/
  .claude/
    agents/
```

## Conventions
- `apps/` holds user-facing applications.
- `services/` holds deployable APIs and workers.
- `packages/` holds shared code.
- `infra/` holds deployment and provisioning.
- `docs/` holds product and engineering decisions.
- `.claude/agents/` holds Claude Code subagent definitions.

## Recommended service split
- auth
- profile
- jobs
- matching
- applications
- referrals
- outreach
- learning
- connectors
- analytics
- admin
