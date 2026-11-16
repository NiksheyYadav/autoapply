import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMBER_ROLES, type MemberRole } from '@atlas/types';
import { ADMIN_BASE, createHarness, testDatabaseUrl, type Harness } from './support.js';

// Authorization matrix for every admin endpoint. Each route is exercised through
// the real guard against real organization_members rows.
describe.skipIf(!testDatabaseUrl)('admin-service authorization', () => {
  let h: Harness;
  let orgId: string;
  let otherOrgId: string;
  let studentId: string;
  let otherOrgStudentId: string;
  const people: Partial<Record<MemberRole, string>> = {};
  let outsiderId: string; // owner of a different university: must be a stranger here
  let nonMemberId: string; // belongs to no organization at all

  beforeAll(async () => {
    h = await createHarness();
    orgId = await h.seedOrganization('university');
    otherOrgId = await h.seedOrganization('university');

    for (const role of MEMBER_ROLES) {
      const user = await h.seedUser();
      await h.addMember(orgId, user.userId, role);
      people[role] = user.userId;
    }
    const outsider = await h.seedUser();
    await h.addMember(otherOrgId, outsider.userId, 'owner');
    outsiderId = outsider.userId;
    nonMemberId = (await h.seedUser()).userId;

    const student = await h.seedUser();
    studentId = await h.addStudent(orgId, student.userId);
    const otherStudent = await h.seedUser();
    otherOrgStudentId = await h.addStudent(otherOrgId, otherStudent.userId);
  });

  afterAll(async () => {
    await h.close();
  });

  const endpoints = (org: string, student: string) => [
    { name: 'list', method: 'GET' as const, url: `${ADMIN_BASE}/${org}/students` },
    { name: 'detail', method: 'GET' as const, url: `${ADMIN_BASE}/${org}/students/${student}` },
    { name: 'funnel', method: 'GET' as const, url: `${ADMIN_BASE}/${org}/funnel` },
    { name: 'export', method: 'GET' as const, url: `${ADMIN_BASE}/${org}/export.csv` },
    { name: 'import', method: 'POST' as const, url: `${ADMIN_BASE}/${org}/students/import` },
  ];

  async function call(endpoint: { method: 'GET' | 'POST'; url: string }, userId: string | null) {
    const headers: Record<string, string> = userId ? await h.authHeaders(userId) : {};
    if (endpoint.method === 'POST') {
      return h.app.inject({
        method: 'POST',
        url: endpoint.url,
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        payload: JSON.stringify({ rows: [{ email: 'nobody@example.test', full_name: 'No Body' }] }),
      });
    }
    return h.app.inject({ method: 'GET', url: endpoint.url, headers });
  }

  it('rejects unauthenticated requests with 401 on every endpoint', async () => {
    for (const endpoint of endpoints(orgId, studentId)) {
      const res = await call(endpoint, null);
      expect(res.statusCode, endpoint.name).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects a malformed or foreign-signed token with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${orgId}/students`,
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers 401 before it looks at the idempotency key', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${ADMIN_BASE}/${orgId}/students/import`,
      headers: { 'content-type': 'application/json' },
      payload: '{"rows":[]}',
    });
    expect(res.statusCode).toBe(401);
  });

  it.each(['owner', 'admin'] as const)('allows an org %s on every endpoint', async (role) => {
    for (const endpoint of endpoints(orgId, studentId)) {
      const res = await call(endpoint, people[role]!);
      expect(res.statusCode, `${role} ${endpoint.name}`).toBe(200);
    }
  });

  it.each(['member', 'student', 'recruiter'] as const)(
    'forbids an org %s with 403 on every endpoint',
    async (role) => {
      for (const endpoint of endpoints(orgId, studentId)) {
        const res = await call(endpoint, people[role]!);
        expect(res.statusCode, `${role} ${endpoint.name}`).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
    },
  );

  it('forbids a privileged member before the idempotency key is considered', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${ADMIN_BASE}/${orgId}/students/import`,
      headers: { ...(await h.authHeaders(people.member!)), 'content-type': 'application/json' },
      payload: '{"rows":[]}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('answers 404 to a stranger, identically for an organization that exists and one that does not', async () => {
    const unknownOrg = randomUUID();
    for (const userId of [outsiderId, nonMemberId]) {
      for (const endpoint of endpoints(orgId, studentId)) {
        const existing = await call(endpoint, userId);
        expect(existing.statusCode, endpoint.name).toBe(404);

        const missing = await call(
          endpoints(unknownOrg, studentId).find((candidate) => candidate.name === endpoint.name)!,
          userId,
        );
        expect(missing.statusCode).toBe(404);
        expect(existing.json().error.code).toBe(missing.json().error.code);
        expect(existing.json().error.message).toBe(missing.json().error.message);
      }
    }
  });

  it("does not let another organization's owner reach this organization's students by id", async () => {
    // Owner of otherOrg, using their own org in the URL, asks for a student of orgId.
    const res = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${otherOrgId}/students/${studentId}`,
      headers: await h.authHeaders(outsiderId),
    });
    expect(res.statusCode).toBe(404);
    // …and the reverse: a student of the other org through this org's URL.
    const reverse = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${orgId}/students/${otherOrgStudentId}`,
      headers: await h.authHeaders(people.owner!),
    });
    expect(reverse.statusCode).toBe(404);
    expect(reverse.json().error.code).toBe('NOT_FOUND');
  });

  it('trusts organization_members, not the token claims', async () => {
    // A plain member whose token claims "owner of orgId" is still a member in the database.
    const forged = await h.token(people.member!, { org: orgId, role: 'owner' });
    const res = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${orgId}/students`,
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(403);

    // A stranger claiming membership gets 404, not access.
    const claimed = await h.token(nonMemberId, { org: orgId, role: 'admin' });
    const stranger = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${orgId}/students`,
      headers: { authorization: `Bearer ${claimed}` },
    });
    expect(stranger.statusCode).toBe(404);
  });

  it('honors a membership change immediately, without waiting for the token to expire', async () => {
    const user = await h.seedUser();
    await h.addMember(orgId, user.userId, 'admin');
    const headers = await h.authHeaders(user.userId);
    const url = `${ADMIN_BASE}/${orgId}/students`;

    expect((await h.app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
    await h.handle
      .sql`delete from organization_members where organization_id = ${orgId} and user_id = ${user.userId}`;
    expect((await h.app.inject({ method: 'GET', url, headers })).statusCode).toBe(404);
  });

  it('applies to university organizations only', async () => {
    for (const type of ['enterprise', 'individual'] as const) {
      const org = await h.seedOrganization(type);
      const owner = await h.seedUser();
      await h.addMember(org, owner.userId, 'owner');
      const res = await h.app.inject({
        method: 'GET',
        url: `${ADMIN_BASE}/${org}/students`,
        headers: await h.authHeaders(owner.userId),
      });
      expect(res.statusCode, type).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('validates :orgId and :studentId as UUIDs (400)', async () => {
    const headers = await h.authHeaders(people.owner!);
    const badOrg = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/not-a-uuid/students`,
      headers,
    });
    expect(badOrg.statusCode).toBe(400);
    expect(badOrg.json().error.code).toBe('VALIDATION_ERROR');

    const badStudent = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${orgId}/students/not-a-uuid`,
      headers,
    });
    expect(badStudent.statusCode).toBe(400);
    expect(badStudent.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('keeps /health public and everything else off the cache', async () => {
    const health = await h.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: 'ok',
      service: 'admin-service',
      checks: { database: 'ok' },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${orgId}/students`,
      headers: await h.authHeaders(people.owner!),
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
