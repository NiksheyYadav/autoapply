import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPLICATION_STATUSES,
  adminFunnelResponseSchema,
  type AdminFunnelResponse,
} from '@atlas/types';
import {
  ADMIN_BASE,
  createCountingDatabase,
  createHarness,
  testDatabaseUrl,
  type CountingDatabase,
  type Harness,
} from './support.js';

// A small, fully specified dataset so every number below can be checked by hand.
//
//  student  member  resumes (created)                  applications in this org (created)
//  s1       yes     ats 80 parsed (03-05)              submitted (03-06), offer (03-10 00:00:00Z exactly)
//  s2       yes     ats 30 (01-05), ats 60 (02-05)     rejected (01-20), interviewing (02-20)
//  s3       yes     failed, no score (02-01)           draft (02-02)
//  s4       yes     -                                  -
//  s5       NO      ats 90 parsed                      submitted, offer      <- not sharing: never counted
//  s6       yes     ats 50 parsed (03-15)              queued in ANOTHER org, submitted with NO org <- not this org's
//  s7       yes     -                                  - (account soft-deleted: roster size only)
describe.skipIf(!testDatabaseUrl)('admin-service funnel', () => {
  let h: Harness;
  let orgId: string;
  let emptyOrgId: string;
  let headers: Record<string, string>;
  let emptyHeaders: Record<string, string>;

  const funnel = async (query = '', org = orgId, hdrs = headers): Promise<AdminFunnelResponse> => {
    const res = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${org}/funnel${query}`,
      headers: hdrs,
    });
    expect(res.statusCode, res.body).toBe(200);
    return adminFunnelResponseSchema.parse(res.json());
  };

  const zeroByStatus = Object.fromEntries(APPLICATION_STATUSES.map((status) => [status, 0]));

  beforeAll(async () => {
    h = await createHarness();
    orgId = await h.seedOrganization('university');
    emptyOrgId = await h.seedOrganization('university');
    const otherOrgId = await h.seedOrganization('university');

    const owner = await h.seedUser();
    await h.addMember(orgId, owner.userId, 'owner');
    headers = await h.authHeaders(owner.userId);
    const emptyOwner = await h.seedUser();
    await h.addMember(emptyOrgId, emptyOwner.userId, 'owner');
    emptyHeaders = await h.authHeaders(emptyOwner.userId);

    const student = async (options: { member?: boolean; deleted?: boolean } = {}) => {
      const user = await h.seedUser(options.deleted ? { deleted: true } : {});
      if (options.member !== false) await h.addMember(orgId, user.userId, 'student');
      await h.addStudent(orgId, user.userId);
      return user.userId;
    };

    const s1 = await student();
    await h.seedResume(s1, { atsScore: 80, createdAt: '2026-03-05T00:00:00Z' });
    await h.seedApplication(s1, {
      status: 'submitted',
      organizationId: orgId,
      createdAt: '2026-03-06T00:00:00Z',
    });
    await h.seedApplication(s1, {
      status: 'offer',
      organizationId: orgId,
      createdAt: '2026-03-10T00:00:00Z',
    });

    const s2 = await student();
    await h.seedResume(s2, { atsScore: 30, createdAt: '2026-01-05T00:00:00Z' });
    await h.seedResume(s2, { atsScore: 60, createdAt: '2026-02-05T00:00:00Z' });
    await h.seedApplication(s2, {
      status: 'rejected',
      organizationId: orgId,
      createdAt: '2026-01-20T00:00:00Z',
    });
    await h.seedApplication(s2, {
      status: 'interviewing',
      organizationId: orgId,
      createdAt: '2026-02-20T00:00:00Z',
    });

    const s3 = await student();
    await h.seedResume(s3, { atsScore: null, status: 'failed', createdAt: '2026-02-01T00:00:00Z' });
    await h.seedApplication(s3, {
      status: 'draft',
      organizationId: orgId,
      createdAt: '2026-02-02T00:00:00Z',
    });

    await student(); // s4

    const s5 = await student({ member: false });
    await h.seedResume(s5, { atsScore: 90, createdAt: '2026-03-07T00:00:00Z' });
    await h.seedApplication(s5, {
      status: 'submitted',
      organizationId: orgId,
      createdAt: '2026-03-07T00:00:00Z',
    });
    await h.seedApplication(s5, {
      status: 'offer',
      organizationId: orgId,
      createdAt: '2026-03-08T00:00:00Z',
    });

    const s6 = await student();
    await h.seedResume(s6, { atsScore: 50, createdAt: '2026-03-15T00:00:00Z' });
    await h.seedApplication(s6, {
      status: 'queued',
      organizationId: otherOrgId,
      createdAt: '2026-03-16T00:00:00Z',
    });
    await h.seedApplication(s6, {
      status: 'submitted',
      organizationId: null,
      createdAt: '2026-03-17T00:00:00Z',
    });

    await student({ deleted: true }); // s7
  });

  afterAll(async () => {
    await h.close();
  });

  it('counts the roster, sign-ups and sharing students', async () => {
    const body = await funnel();
    expect(body.organization_id).toBe(orgId);
    expect(body.roster).toEqual({ size: 7, signed_up: 6, sharing_enabled: 5 });
    expect(body.range).toEqual({ from: null, to: null });
  });

  it('counts resumes and averages each student’s latest scored resume', async () => {
    const body = await funnel();
    // s1, s2, s3 (failed upload) and s6 uploaded; s5 is not sharing.
    expect(body.resumes.students_with_resume).toBe(4);
    // Latest scored: s1 80, s2 60 (not the older 30), s6 50. s3's failed resume has no score.
    expect(body.resumes.students_with_ats_score).toBe(3);
    expect(body.resumes.avg_ats_score).toBe(63.3);
  });

  it('counts applications by every status, only for sharing students and only in this organization', async () => {
    const body = await funnel();
    expect(body.applications.total).toBe(5);
    expect(body.applications.students_applied).toBe(3);
    expect(body.applications.by_status).toEqual({
      ...zeroByStatus,
      submitted: 1,
      offer: 1,
      rejected: 1,
      interviewing: 1,
      draft: 1,
    });
    expect(Object.keys(body.applications.by_status)).toEqual([...APPLICATION_STATUSES]);
    expect(body.offers).toEqual({ applications: 1, students: 1 });
  });

  it('scopes activity to a date range: from inclusive, to exclusive, offsets honored', async () => {
    const march = await funnel(
      `?from=${encodeURIComponent('2026-03-01T00:00:00Z')}&to=${encodeURIComponent('2026-04-01T00:00:00Z')}`,
    );
    expect(march.range).toEqual({
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
    });
    expect(march.resumes).toEqual({
      students_with_resume: 2,
      students_with_ats_score: 2,
      avg_ats_score: 65,
    });
    expect(march.applications.total).toBe(2);
    expect(march.applications.students_applied).toBe(1);
    expect(march.offers).toEqual({ applications: 1, students: 1 });
    // The roster is a snapshot, not activity.
    expect(march.roster).toEqual({ size: 7, signed_up: 6, sharing_enabled: 5 });

    const february = await funnel(
      `?from=${encodeURIComponent('2026-02-01T00:00:00Z')}&to=${encodeURIComponent('2026-03-01T00:00:00Z')}`,
    );
    expect(february.resumes).toEqual({
      students_with_resume: 2,
      students_with_ats_score: 1,
      avg_ats_score: 60,
    });
    expect(february.applications.by_status).toEqual({ ...zeroByStatus, interviewing: 1, draft: 1 });
    expect(february.offers).toEqual({ applications: 0, students: 0 });

    // `to` is exclusive: the offer created at exactly 03-10T00:00:00Z is outside [03-01, 03-10).
    const beforeOffer = await funnel(
      `?from=${encodeURIComponent('2026-03-01T00:00:00Z')}&to=${encodeURIComponent('2026-03-10T00:00:00Z')}`,
    );
    expect(beforeOffer.offers.applications).toBe(0);
    expect(beforeOffer.applications.total).toBe(1);
    // …and `from` is inclusive, including when written with a UTC offset.
    const atOffer = await funnel(
      `?from=${encodeURIComponent('2026-03-10T02:00:00+02:00')}&to=${encodeURIComponent('2026-03-11T00:00:00Z')}`,
    );
    expect(atOffer.offers.applications).toBe(1);

    const openEnded = await funnel(`?from=${encodeURIComponent('2026-03-10T00:00:00Z')}`);
    expect(openEnded.applications.total).toBe(1);
    const untilFeb = await funnel(`?to=${encodeURIComponent('2026-02-01T00:00:00Z')}`);
    expect(untilFeb.applications.by_status).toEqual({ ...zeroByStatus, rejected: 1 });
  });

  it('rejects a bad range with 400', async () => {
    for (const query of [
      `?from=${encodeURIComponent('2026-04-01T00:00:00Z')}&to=${encodeURIComponent('2026-03-01T00:00:00Z')}`,
      `?from=${encodeURIComponent('2026-03-01T00:00:00Z')}&to=${encodeURIComponent('2026-03-01T00:00:00Z')}`,
      '?from=yesterday',
      '?to=2026-13-45',
      '?from=2026-03-01',
    ]) {
      const res = await h.app.inject({
        method: 'GET',
        url: `${ADMIN_BASE}/${orgId}/funnel${query}`,
        headers,
      });
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('reports zeros, not errors, for an organization with no roster', async () => {
    const body = await funnel('', emptyOrgId, emptyHeaders);
    expect(body).toMatchObject({
      roster: { size: 0, signed_up: 0, sharing_enabled: 0 },
      resumes: { students_with_resume: 0, students_with_ats_score: 0, avg_ats_score: null },
      applications: { total: 0, students_applied: 0, by_status: zeroByStatus },
      offers: { applications: 0, students: 0 },
    });
  });

  it('exposes aggregates only', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${orgId}/funnel`,
      headers,
    });
    for (const secret of ['CONFIDENTIAL', 'email', '@', 'user_id', 'student_id', 'full_name']) {
      expect(res.body, secret).not.toContain(secret);
    }
  });

  describe('query count', () => {
    let counting: CountingDatabase;
    let countedHarness: Harness;
    let countedOrgId: string;
    let countedHeaders: Record<string, string>;

    beforeAll(async () => {
      counting = createCountingDatabase();
      countedHarness = await createHarness({ db: counting.db, sql: counting.sql });
      countedOrgId = await countedHarness.seedOrganization('university');
      const owner = await countedHarness.seedUser();
      await countedHarness.addMember(countedOrgId, owner.userId, 'owner');
      countedHeaders = await countedHarness.authHeaders(owner.userId);
    });

    afterAll(async () => {
      await countedHarness.close();
      await counting.close();
    });

    async function addSharingStudents(count: number) {
      for (let index = 0; index < count; index += 1) {
        const user = await countedHarness.seedUser();
        await countedHarness.addMember(countedOrgId, user.userId, 'student');
        await countedHarness.addStudent(countedOrgId, user.userId);
        await countedHarness.seedResume(user.userId, { atsScore: 70 });
        await countedHarness.seedApplication(user.userId, {
          status: 'submitted',
          organizationId: countedOrgId,
        });
      }
    }

    async function statementsFor(url: string): Promise<number> {
      counting.reset();
      const res = await countedHarness.app.inject({ method: 'GET', url, headers: countedHeaders });
      expect(res.statusCode, res.body).toBe(200);
      return counting.count();
    }

    it('runs the same number of statements for 3 students as for 33', async () => {
      await addSharingStudents(3);
      // Warm the pool first: each new connection runs its own driver bootstrap queries, which are not the app's.
      await statementsFor(`${ADMIN_BASE}/${countedOrgId}/funnel`);
      await statementsFor(`${ADMIN_BASE}/${countedOrgId}/students?limit=100`);
      await statementsFor(`${ADMIN_BASE}/${countedOrgId}/export.csv`);

      const funnelSmall = await statementsFor(`${ADMIN_BASE}/${countedOrgId}/funnel`);
      const listSmall = await statementsFor(`${ADMIN_BASE}/${countedOrgId}/students?limit=100`);
      const exportSmall = await statementsFor(`${ADMIN_BASE}/${countedOrgId}/export.csv`);

      await addSharingStudents(30);
      const funnelLarge = await statementsFor(`${ADMIN_BASE}/${countedOrgId}/funnel`);
      const listLarge = await statementsFor(`${ADMIN_BASE}/${countedOrgId}/students?limit=100`);
      const exportLarge = await statementsFor(`${ADMIN_BASE}/${countedOrgId}/export.csv`);

      expect(funnelLarge).toBe(funnelSmall);
      expect(listLarge).toBe(listSmall);
      expect(exportLarge).toBe(exportSmall);
      // A handful of grouped statements, not one per student.
      expect(funnelSmall).toBeLessThanOrEqual(8);
      expect(listSmall).toBeLessThanOrEqual(8);
    });
  });
});
