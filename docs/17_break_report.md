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
| 4 | Medium | Config | `CORS_ORIGINS` entries were not checked. `https://app.example.com/` (trailing slash), `app.example.com` (no scheme), a URL with a path, or `null` started the service fine and then matched no browser `Origin`, so every browser call failed with a CORS error and nothing in the logs said why. | Fixed: a trailing slash and upper-case are forgiven (normalized to the exact origin form), and an entry that can never match stops the boot with the entry named. Tests in `packages/config/test/cors-origins.test.ts`. |
| 5 | Low | Config | `CORS_ORIGINS=*` is accepted in production although `docs/16` says never to use it and the config comment says development only. The API authenticates with bearer tokens, not cookies, so a wildcard does not expose a session, but the rule is not enforced. | Open: needs an owner decision, because the live preview may rely on `*` (see `NEXT.md`, "Needs Nikshey"). |

## What was checked and held

- `vercel.json`: every `/v1/...` and `/internal/<service>/...` route that each deployed service declares resolves to that service's function, every rewrite destination has a bundle and a function entry, and the service-local `/internal/drain`, `/health` and `/metrics` are not routed at all. New test `packages/utils/test/vercel-routing.test.ts` (it fails when a rewrite is removed).
- Drain and ingest secret checks (`isAuthorizedDrainRequest`): hashed and compared in constant time, no length oracle, empty secret never matches, a duplicate `Authorization` header (joined with a comma by Node) is refused, a secret containing spaces fails closed.
- `RATE_LIMIT_MAX` of 0 is refused at boot (`min(1)`).
- `/health`, `/metrics` and `/internal/*` are exempt because they are registered outside the limited scope, not by path matching, so no path trick can move a business route into the exempt set.
