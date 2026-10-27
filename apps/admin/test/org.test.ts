import { describe, expect, it } from 'vitest';
import {
  candidateOrganizations,
  isOrganizationId,
  isRosterRole,
  parseOrganizationIdInput,
  resolveLanding,
  shortId,
} from '../src/lib/org';

const ORG = '0b6d2a4e-6f43-4a39-9a43-4a1d3c1a8e11';

describe('isRosterRole', () => {
  it('accepts exactly the roles the API accepts', () => {
    expect(isRosterRole('owner')).toBe(true);
    expect(isRosterRole('admin')).toBe(true);
    for (const role of ['member', 'student', 'recruiter', '', null, undefined, 'Admin', 'platform_admin']) {
      expect(isRosterRole(role)).toBe(false);
    }
  });
});

describe('isOrganizationId / parseOrganizationIdInput', () => {
  it('validates with the same rule as the API', () => {
    expect(isOrganizationId(ORG)).toBe(true);
    for (const bad of ['', 'platform', '../etc/passwd', `${ORG}/students`, ORG.slice(1), 42, null, undefined]) {
      expect(isOrganizationId(bad)).toBe(false);
    }
  });

  it('canonicalises a pasted id and rejects junk', () => {
    expect(parseOrganizationIdInput(`  ${ORG.toUpperCase()}\n`)).toBe(ORG);
    expect(parseOrganizationIdInput('not-an-id')).toBeNull();
    expect(parseOrganizationIdInput('')).toBeNull();
    expect(parseOrganizationIdInput(`${ORG} extra`)).toBeNull();
  });

  it('shortens an id to its first block', () => {
    expect(shortId(ORG)).toBe('0b6d2a4e');
  });
});

describe('candidateOrganizations', () => {
  it('has no candidates for an account with no organization in its token', () => {
    expect(candidateOrganizations({ organizationId: null, role: null })).toEqual([]);
  });

  it('has no candidates when the claim is not a valid id', () => {
    expect(candidateOrganizations({ organizationId: 'garbage', role: 'admin' })).toEqual([]);
  });

  it('reports the claimed role and whether it is a roster role', () => {
    expect(candidateOrganizations({ organizationId: ORG, role: 'owner' })).toEqual([
      { organizationId: ORG, claimedRole: 'owner', claimsRosterAccess: true },
    ]);
    expect(candidateOrganizations({ organizationId: ORG, role: 'student' })).toEqual([
      { organizationId: ORG, claimedRole: 'student', claimsRosterAccess: false },
    ]);
    expect(candidateOrganizations({ organizationId: ORG, role: null })[0]?.claimsRosterAccess).toBe(false);
  });
});

describe('resolveLanding', () => {
  it('opens the organization straight away for an owner or admin claim', () => {
    expect(resolveLanding({ organizationId: ORG, role: 'admin' })).toEqual({ kind: 'open', organizationId: ORG });
    expect(resolveLanding({ organizationId: ORG, role: 'owner' })).toEqual({ kind: 'open', organizationId: ORG });
  });

  it('sends everyone else to the organization chooser instead of guessing', () => {
    expect(resolveLanding({ organizationId: ORG, role: 'member' })).toEqual({ kind: 'choose' });
    expect(resolveLanding({ organizationId: null, role: null })).toEqual({ kind: 'choose' });
    expect(resolveLanding({ organizationId: null, role: 'admin' })).toEqual({ kind: 'choose' });
  });
});
