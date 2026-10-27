import { describe, expect, it } from 'vitest';
import { isPlatformAdmin, parsePlatformAdminIds, requirePlatformAdmin } from '../src/platform-admin.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const GRACE = '22222222-2222-4222-8222-222222222222';
const MALLORY = '33333333-3333-4333-8333-333333333333';

describe('parsePlatformAdminIds', () => {
  it('treats unset, null, empty, and whitespace/comma-only values as an empty allowlist', () => {
    for (const raw of [undefined, null, '', '   ', ',', ' , ,, ']) {
      expect(parsePlatformAdminIds(raw).size).toBe(0);
    }
  });

  it('splits on commas, trims, lowercases, and drops blanks', () => {
    const ids = parsePlatformAdminIds(` ${ADA.toUpperCase()} ,, ${GRACE},`);
    expect([...ids].sort()).toEqual([ADA, GRACE]);
  });
});

describe('isPlatformAdmin', () => {
  it('is false for everyone when the allowlist is unset or empty (fail closed)', () => {
    expect(isPlatformAdmin({ user_id: ADA }, undefined)).toBe(false);
    expect(isPlatformAdmin({ user_id: ADA }, '')).toBe(false);
  });

  it('is true only for listed user ids', () => {
    expect(isPlatformAdmin({ user_id: ADA }, `${ADA},${GRACE}`)).toBe(true);
    expect(isPlatformAdmin({ user_id: GRACE }, `${ADA},${GRACE}`)).toBe(true);
    expect(isPlatformAdmin({ user_id: MALLORY }, `${ADA},${GRACE}`)).toBe(false);
  });

  it('matches ids case-insensitively', () => {
    expect(isPlatformAdmin({ user_id: ADA }, ADA.toUpperCase())).toBe(true);
  });

  it('does not match on substrings or prefixes of a listed id', () => {
    expect(isPlatformAdmin({ user_id: ADA.slice(0, 8) }, ADA)).toBe(false);
    expect(isPlatformAdmin({ user_id: ADA }, ADA.slice(0, 8))).toBe(false);
  });

  it('ignores org role entirely — an org owner/admin is not a platform admin', () => {
    // Only user_id is consulted; extra actor fields must not influence the outcome.
    const orgOwner = { user_id: MALLORY, role: 'owner', organization_id: GRACE } as const;
    expect(isPlatformAdmin(orgOwner, ADA)).toBe(false);
  });
});

describe('requirePlatformAdmin', () => {
  it('throws FORBIDDEN (403) for a user that is not on the allowlist', () => {
    expect(() => requirePlatformAdmin({ user_id: MALLORY }, ADA)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN', statusCode: 403 }),
    );
  });

  it('throws FORBIDDEN when the allowlist is unset', () => {
    expect(() => requirePlatformAdmin({ user_id: ADA }, undefined)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('uses a caller-supplied message', () => {
    expect(() => requirePlatformAdmin({ user_id: MALLORY }, ADA, 'nope')).toThrowError('nope');
  });

  it('returns normally for a listed user', () => {
    expect(() => requirePlatformAdmin({ user_id: ADA }, ADA)).not.toThrow();
  });
});
