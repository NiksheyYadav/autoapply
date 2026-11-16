import { describe, expect, it } from 'vitest';
import { loadOutreachServiceEnv } from '../src/env.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', PORT: '4007', SUPABASE_URL: 'https://test-project.supabase.co' };

describe('OUTREACH_DELIVERY_ENABLED', () => {
  it('is off unless it is set', () => {
    expect(loadOutreachServiceEnv(base).OUTREACH_DELIVERY_ENABLED).toBe(false);
  });

  it.each([['true'], ['1'], ['yes'], ['on'], ['TRUE']])('reads %s as on', (value) => {
    expect(loadOutreachServiceEnv({ ...base, OUTREACH_DELIVERY_ENABLED: value }).OUTREACH_DELIVERY_ENABLED).toBe(true);
  });

  it.each([['false'], ['0'], ['no'], ['off']])('reads %s as off', (value) => {
    expect(loadOutreachServiceEnv({ ...base, OUTREACH_DELIVERY_ENABLED: value }).OUTREACH_DELIVERY_ENABLED).toBe(false);
  });

  // A typo must stop the boot: reading it as "off" (or "on") would be guessing about whether
  // users' messages get delivered.
  it.each([['ture'], ['enable'], ['tru'], ['2'], ['']])('fails at boot on the unrecognised value %j', (value) => {
    expect(() => loadOutreachServiceEnv({ ...base, OUTREACH_DELIVERY_ENABLED: value })).toThrow(/OUTREACH_DELIVERY_ENABLED/);
  });

  it('refuses delivery with the log-only local transport in production', () => {
    expect(() =>
      loadOutreachServiceEnv({ ...base, NODE_ENV: 'production', OUTREACH_DELIVERY_ENABLED: 'true', OUTREACH_TRANSPORT_DRIVER: 'local' }),
    ).toThrow(/OUTREACH_DELIVERY_ENABLED.*local transport only logs/s);
    // The default transport is local, so leaving the driver unset is the same mistake.
    expect(() => loadOutreachServiceEnv({ ...base, NODE_ENV: 'production', OUTREACH_DELIVERY_ENABLED: 'true' })).toThrow(
      /OUTREACH_DELIVERY_ENABLED/,
    );
  });

  it('still allows delivery with the local transport outside production, and production with delivery off', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(loadOutreachServiceEnv({ ...base, NODE_ENV, OUTREACH_DELIVERY_ENABLED: 'true' }).OUTREACH_DELIVERY_ENABLED).toBe(true);
    }
    expect(loadOutreachServiceEnv({ ...base, NODE_ENV: 'production' }).OUTREACH_DELIVERY_ENABLED).toBe(false);
  });
});
