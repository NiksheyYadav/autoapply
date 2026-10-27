#!/usr/bin/env node
/**
 * Post-deploy smoke check for a Project Atlas deployment. No dependencies,
 * no credentials needed, and nothing is written: it only proves each backend
 * function boots with valid configuration, is routed correctly, enforces
 * authentication, and (optionally) that the web app and CORS are wired.
 *
 *   ATLAS_API_BASE_URL=https://api.example.com \
 *   ATLAS_WEB_URL=https://app.example.com \
 *   node scripts/smoke.mjs
 *
 * Layouts (same variables as .github/workflows/drain-events.yml):
 *   - ONE Vercel project behind a shared origin: set ATLAS_API_BASE_URL.
 *   - One project PER SERVICE: set ATLAS_<SERVICE>_URL (ATLAS_AUTH_URL,
 *     ATLAS_PROFILE_URL, ATLAS_JOBS_URL, ATLAS_MATCHING_URL,
 *     ATLAS_APPLICATIONS_URL, ATLAS_REFERRALS_URL, ATLAS_OUTREACH_URL,
 *     ATLAS_LEARNING_URL, ATLAS_ANALYTICS_URL, ATLAS_ADMIN_URL); each
 *     overrides ATLAS_API_BASE_URL for that service.
 *
 * Optional: CRON_SECRET makes the drain probes authenticate and actually run a
 * drain (it processes queued events, which is safe and idempotent). Without
 * it the probes only check that the route is protected.
 *
 * Exit code is 1 if any check FAILS; WARN means "works, but not fully
 * configured yet" and does not fail the run.
 */

const TIMEOUT_MS = 20_000;
const NIL_UUID = '00000000-0000-4000-8000-000000000000';

/** A protected route per service: unauthenticated, it must answer 401 from the service itself. */
export const AUTH_PROBES = [
  { service: 'auth', path: '/v1/auth/me' },
  { service: 'profile', path: '/v1/resumes' },
  { service: 'jobs', path: '/v1/jobs' },
  { service: 'applications', path: '/v1/applications' },
  { service: 'referrals', path: '/v1/referrals' },
  { service: 'outreach', path: '/v1/messages' },
  { service: 'learning', path: '/v1/learning/metrics' },
  { service: 'analytics', path: '/v1/analytics/summary' },
  { service: 'admin', path: `/v1/admin/organizations/${NIL_UUID}/students` },
];

/** Services that consume events and expose a CRON_SECRET-protected drain route. */
export const DRAIN_SERVICES = ['matching', 'referrals', 'learning', 'analytics'];

export const WEB_PATHS = ['/', '/login', '/register', '/forgot-password', '/privacy'];

/** Resolves the origin for a service: ATLAS_<SERVICE>_URL, else ATLAS_API_BASE_URL. */
export function serviceOrigin(service, env) {
  const specific = env[`ATLAS_${service.toUpperCase()}_URL`];
  const origin = specific || env.ATLAS_API_BASE_URL;
  return origin ? origin.replace(/\/+$/, '') : undefined;
}

/**
 * Classifies an unauthenticated probe response. A 401 whose body is the
 * service's JSON error envelope proves the function ran; HTML or a platform
 * error page means it did not.
 */
export function classifyAuthProbe({ status, contentType, body }) {
  const isJson = (contentType ?? '').includes('application/json');
  if (status === 401 && isJson) return { result: 'pass', note: '401 from the service' };
  if (status === 404) return { result: 'fail', note: '404: route or rewrite is not wired to this function' };
  if (status >= 500) return { result: 'fail', note: `${status}: function crashed or failed to boot (check env and logs)` };
  if (status === 401) return { result: 'fail', note: '401 but not a JSON error envelope (platform auth/protection in front?)' };
  if (status === 403 && !isJson) return { result: 'fail', note: '403 from the platform (Vercel deployment protection?), not from the service' };
  return { result: 'fail', note: `unexpected ${status}${body ? `: ${String(body).slice(0, 80)}` : ''}` };
}

/** Classifies a drain probe: 401 = protected and configured, 503 = CRON_SECRET unset, 200 = ran. */
export function classifyDrainProbe({ status, authenticated }) {
  if (authenticated) {
    return status === 200
      ? { result: 'pass', note: 'drained' }
      : { result: 'fail', note: `${status}: authenticated drain did not succeed` };
  }
  if (status === 401) return { result: 'pass', note: 'protected (401 without credentials)' };
  if (status === 503) return { result: 'warn', note: '503: CRON_SECRET is not set on this service, so events are never drained' };
  if (status === 404) return { result: 'fail', note: '404: drain route is not reachable' };
  if (status === 200) return { result: 'fail', note: '200 without credentials: drain endpoint is OPEN' };
  return { result: 'fail', note: `unexpected ${status}` };
}

async function request(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json') || contentType.includes('text') ? await response.text() : '';
  return { status: response.status, contentType, headers: response.headers, body };
}

async function run(env) {
  const rows = [];
  const add = (check, result, note) => rows.push({ check, result, note });

  for (const probe of AUTH_PROBES) {
    const origin = serviceOrigin(probe.service, env);
    const check = `${probe.service}: GET ${probe.path} (no credentials)`;
    if (!origin) {
      add(check, 'skip', `set ATLAS_API_BASE_URL or ATLAS_${probe.service.toUpperCase()}_URL`);
      continue;
    }
    try {
      const response = await request(`${origin}${probe.path}`);
      const verdict = classifyAuthProbe(response);
      add(check, verdict.result, verdict.note);
    } catch (cause) {
      add(check, 'fail', `request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  for (const service of DRAIN_SERVICES) {
    const origin = serviceOrigin(service, env);
    const check = `${service}: POST /internal/${service}/drain`;
    if (!origin) {
      add(check, 'skip', `set ATLAS_API_BASE_URL or ATLAS_${service.toUpperCase()}_URL`);
      continue;
    }
    const url = `${origin}/internal/${service}/drain`;
    try {
      const anonymous = await request(url, { method: 'POST' });
      const verdict = classifyDrainProbe({ status: anonymous.status, authenticated: false });
      add(`${check} (no credentials)`, verdict.result, verdict.note);
      if (env.CRON_SECRET) {
        const authed = await request(url, { method: 'POST', headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
        const authedVerdict = classifyDrainProbe({ status: authed.status, authenticated: true });
        add(`${check} (CRON_SECRET)`, authedVerdict.result, authedVerdict.note);
      }
    } catch (cause) {
      add(check, 'fail', `request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  const web = env.ATLAS_WEB_URL?.replace(/\/+$/, '');
  if (!web) {
    add('web: pages', 'skip', 'set ATLAS_WEB_URL');
  } else {
    for (const path of WEB_PATHS) {
      try {
        const response = await request(`${web}${path}`);
        const ok = response.status === 200 && response.contentType.includes('text/html');
        add(`web: GET ${path}`, ok ? 'pass' : 'fail', ok ? '200 html' : `${response.status} ${response.contentType}`);
      } catch (cause) {
        add(`web: GET ${path}`, 'fail', `request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    const authOrigin = serviceOrigin('auth', env);
    if (authOrigin) {
      try {
        const response = await request(`${authOrigin}/v1/auth/me`, {
          method: 'OPTIONS',
          headers: { origin: web, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
        });
        const allowed = response.headers.get('access-control-allow-origin');
        add(
          'cors: web origin may call the API',
          allowed === web ? 'pass' : 'fail',
          allowed === web ? `allow-origin ${allowed}` : `allow-origin is "${allowed ?? 'absent'}", expected "${web}" (set CORS_ORIGINS)`,
        );
      } catch (cause) {
        add('cors: web origin may call the API', 'fail', `request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  return rows;
}

function printReport(rows) {
  const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };
  const width = Math.max(...rows.map((row) => row.check.length));
  for (const row of rows) console.log(`${icon[row.result]}  ${row.check.padEnd(width)}  ${row.note}`);
  const count = (result) => rows.filter((row) => row.result === result).length;
  console.log(`\n${count('pass')} passed, ${count('warn')} warnings, ${count('fail')} failed, ${count('skip')} skipped`);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const rows = await run(process.env);
  printReport(rows);
  if (rows.every((row) => row.result === 'skip')) {
    console.error('\nNothing was checked: set ATLAS_API_BASE_URL (and/or ATLAS_<SERVICE>_URL, ATLAS_WEB_URL).');
    process.exit(2);
  }
  process.exit(rows.some((row) => row.result === 'fail') ? 1 : 0);
}
