import { describe, expect, it } from 'vitest';
// The post-deploy smoke script lives in scripts/; its decision logic is pure and tested here.
import { AUTH_PROBES, DRAIN_SERVICES, classifyAuthProbe, classifyDrainProbe, serviceOrigin } from '../../../scripts/smoke.mjs';

describe('smoke script: origin resolution', () => {
  it('prefers a per-service origin over the shared base URL and trims trailing slashes', () => {
    const env = { ATLAS_API_BASE_URL: 'https://api.example.com/', ATLAS_JOBS_URL: 'https://jobs.example.com//' };
    expect(serviceOrigin('jobs', env)).toBe('https://jobs.example.com');
    expect(serviceOrigin('auth', env)).toBe('https://api.example.com');
  });

  it('returns undefined when nothing is configured', () => {
    expect(serviceOrigin('auth', {})).toBeUndefined();
  });

  it('probes every backend service that serves /v1 routes, and every event consumer', () => {
    expect(AUTH_PROBES.map((probe) => probe.service).sort()).toEqual(
      ['admin', 'analytics', 'applications', 'auth', 'jobs', 'learning', 'outreach', 'profile', 'referrals'].sort(),
    );
    expect([...DRAIN_SERVICES].sort()).toEqual(['analytics', 'learning', 'matching', 'referrals']);
  });
});

describe('smoke script: auth probe classification', () => {
  const json = 'application/json; charset=utf-8';

  it('passes only a JSON 401 from the service itself', () => {
    expect(classifyAuthProbe({ status: 401, contentType: json, body: '{}' }).result).toBe('pass');
  });

  it.each([
    [404, json, 'route or rewrite'],
    [500, json, 'crashed'],
    [502, 'text/html', 'crashed'],
    [401, 'text/html', 'not a JSON'],
    [403, 'text/html', 'platform'],
    [200, json, 'unexpected 200'],
  ])('fails %i (%s)', (status, contentType, fragment) => {
    const verdict = classifyAuthProbe({ status, contentType, body: '' });
    expect(verdict.result).toBe('fail');
    expect(verdict.note).toContain(fragment);
  });
});

describe('smoke script: drain probe classification', () => {
  it('treats 401 without credentials as protected, 503 as unconfigured, and an open endpoint as a failure', () => {
    expect(classifyDrainProbe({ status: 401, authenticated: false }).result).toBe('pass');
    expect(classifyDrainProbe({ status: 503, authenticated: false }).result).toBe('warn');
    expect(classifyDrainProbe({ status: 200, authenticated: false }).result).toBe('fail');
    expect(classifyDrainProbe({ status: 404, authenticated: false }).result).toBe('fail');
  });

  it('requires 200 when the request carries the secret', () => {
    expect(classifyDrainProbe({ status: 200, authenticated: true }).result).toBe('pass');
    expect(classifyDrainProbe({ status: 401, authenticated: true }).result).toBe('fail');
  });
});
