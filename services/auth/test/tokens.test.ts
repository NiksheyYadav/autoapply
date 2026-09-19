import { describe, expect, it } from 'vitest';
import { createTokenConfig, issueTokenPair, signAccessToken, verifyAccessToken } from '../src/security/tokens.js';

const baseEnv = {
  JWT_ISSUER: 'atlas-test',
  JWT_AUDIENCE: 'atlas-test-clients',
  ACCESS_TOKEN_TTL_SECONDS: 900,
};

const config = createTokenConfig({ ...baseEnv, JWT_SECRET: 'a'.repeat(32) });

const claims = {
  sub: '11111111-1111-4111-8111-111111111111',
  sid: '22222222-2222-4222-8222-222222222222',
  org: null,
  role: null,
  email: 'ada@example.com',
};

describe('access tokens', () => {
  it('round-trips claims through sign and verify', async () => {
    const token = await signAccessToken(claims, config);
    const verified = await verifyAccessToken(token, config);
    expect(verified).toEqual(claims);
  });

  it('rejects a token signed with a different secret', async () => {
    const otherConfig = createTokenConfig({ ...baseEnv, JWT_SECRET: 'b'.repeat(32) });
    const token = await signAccessToken(claims, otherConfig);
    await expect(verifyAccessToken(token, config)).rejects.toThrow();
  });

  it('rejects a token issued for a different audience', async () => {
    const otherConfig = createTokenConfig({
      ...baseEnv,
      JWT_SECRET: 'a'.repeat(32),
      JWT_AUDIENCE: 'someone-else',
    });
    const token = await signAccessToken(claims, otherConfig);
    await expect(verifyAccessToken(token, config)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const expiredConfig = createTokenConfig({ ...baseEnv, JWT_SECRET: 'a'.repeat(32), ACCESS_TOKEN_TTL_SECONDS: -10 });
    const token = await signAccessToken(claims, expiredConfig);
    await expect(verifyAccessToken(token, config)).rejects.toThrow();
  });

  it('issues a token pair carrying the configured TTL', async () => {
    const pair = await issueTokenPair(claims, 'a-refresh-token', config);
    expect(pair.token_type).toBe('Bearer');
    expect(pair.expires_in).toBe(900);
    expect(pair.refresh_token).toBe('a-refresh-token');
    expect(typeof pair.access_token).toBe('string');
  });
});
