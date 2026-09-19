import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createTokenVerifierConfig, verifyAccessToken } from '../src/tokens.js';

const baseEnv = { JWT_ISSUER: 'atlas-test', JWT_AUDIENCE: 'atlas-test-clients' };
const config = createTokenVerifierConfig({ ...baseEnv, JWT_SECRET: 'a'.repeat(32) });

const claims = {
  sub: '11111111-1111-4111-8111-111111111111',
  sid: '22222222-2222-4222-8222-222222222222',
  org: null as string | null,
  role: null as string | null,
  email: 'ada@example.com',
};

async function sign(secret: string, overrides: Partial<typeof baseEnv> = {}, ttlSeconds = 900): Promise<string> {
  const env = { ...baseEnv, ...overrides };
  return new SignJWT({ sid: claims.sid, org: claims.org, role: claims.role, email: claims.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(new TextEncoder().encode(secret));
}

describe('verifyAccessToken', () => {
  it('accepts a token signed with the matching secret/issuer/audience', async () => {
    const token = await sign('a'.repeat(32));
    await expect(verifyAccessToken(token, config)).resolves.toEqual(claims);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await sign('b'.repeat(32));
    await expect(verifyAccessToken(token, config)).rejects.toThrow();
  });

  it('rejects a token issued for a different audience', async () => {
    const token = await sign('a'.repeat(32), { JWT_AUDIENCE: 'someone-else' });
    await expect(verifyAccessToken(token, config)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await sign('a'.repeat(32), {}, -10);
    await expect(verifyAccessToken(token, config)).rejects.toThrow();
  });

  it('rejects a malformed bearer string', async () => {
    await expect(verifyAccessToken('not-a-jwt', config)).rejects.toThrow();
  });
});
