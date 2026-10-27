import { describe, expect, it } from 'vitest';
import { loadApplicationsServiceEnv } from '../src/env.js';

const BASE = { DATABASE_URL: 'postgres://atlas:atlas@localhost:5432/atlas', PORT: '4005', SUPABASE_URL: 'https://test-project.supabase.co' };

describe('APPLICATIONS_AUTO_MODE_ENABLED', () => {
  it('defaults to false, so mode "auto" is off unless someone opts in', () => {
    expect(loadApplicationsServiceEnv(BASE).APPLICATIONS_AUTO_MODE_ENABLED).toBe(false);
  });

  it('is on only when explicitly set to true', () => {
    expect(loadApplicationsServiceEnv({ ...BASE, APPLICATIONS_AUTO_MODE_ENABLED: 'true' }).APPLICATIONS_AUTO_MODE_ENABLED).toBe(true);
    expect(loadApplicationsServiceEnv({ ...BASE, APPLICATIONS_AUTO_MODE_ENABLED: 'false' }).APPLICATIONS_AUTO_MODE_ENABLED).toBe(false);
  });

  it('fails fast on a value that is not a boolean, rather than silently picking a side', () => {
    expect(() => loadApplicationsServiceEnv({ ...BASE, APPLICATIONS_AUTO_MODE_ENABLED: 'maybe' })).toThrow(
      /APPLICATIONS_AUTO_MODE_ENABLED/,
    );
  });
});
