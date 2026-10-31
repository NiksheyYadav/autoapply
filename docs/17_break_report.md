# 17. Break report

Findings from trying to break Project Atlas locally (in-process apps, a private Postgres, no live
systems). Newest cycle last. Severity follows the scale used for the exercise: Critical (cross-tenant
access, privilege escalation, secret exposure), High (data loss, business rule bypass), Medium (500s or
hangs on hostile input, silent fail-open settings), Low (hardening gaps), Info (things that held).
Work list: `NEXT.md`.

| # | Sev | Area | Finding | State |
|---|-----|------|---------|-------|
| 1 | Medium | Config | `RATE_LIMIT_WINDOW` was an unchecked string. `abc`, `1 parsec`, an empty value or `0` booted fine and then every business request answered 500 (the limiter threw per request). A negative value (`-5 minutes`) and a bare number (`60`, read as 60 ms) booted fine and limited nothing. The same held for `PRIVACY_RATE_LIMIT_WINDOW`. | Fixed: both are validated at boot (`rateLimitWindowSchema`, one second to seven days, `<number> <unit>` only). Tests in `packages/config/test`. |
| 2 | Info | Rate limit | The limiter's in-memory store is a 5,000-entry LRU, so many unique clients cannot grow memory without bound. | Held. |
| 3 | Low | Rate limit | Clients are told apart by `request.ip` with `trustProxy: true`. That is the first `X-Forwarded-For` entry, which a client chooses unless the edge overwrites the header. Vercel does overwrite it, so the launch deployment is not affected; behind a proxy that only appends, one client could pick fresh buckets at will, or push others' buckets out of the LRU. | Accepted for launch, documented in `registerRateLimitedRoutes`. Revisit if the API ever moves behind another proxy. |

## What was checked and held

- `RATE_LIMIT_MAX` of 0 is refused at boot (`min(1)`).
- `/health`, `/metrics` and `/internal/*` are exempt because they are registered outside the limited scope, not by path matching, so no path trick can move a business route into the exempt set.
