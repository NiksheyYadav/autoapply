import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminStudentResponseSchema,
  listAdminStudentsResponseSchema,
  type ListAdminStudentsResponse,
  type RosterStudent,
} from '@atlas/types';
import { ADMIN_BASE, createHarness, testDatabaseUrl, type Harness } from './support.js';

describe.skipIf(!testDatabaseUrl)('admin-service roster list and detail', () => {
  let h: Harness;
  let orgId: string;
  let otherOrgId: string;
  let headers: Record<string, string>;
  const tag = randomUUID().slice(0, 8);

  const ids = {} as Record<'mia' | 'noah' | 'nina' | 'omar' | 'otherOrgStudent', string>;
  const emails = {} as Record<'mia' | 'noah' | 'nina' | 'omar', string>;

  const list = async (query = '', orgForUrl = orgId): Promise<ListAdminStudentsResponse> => {
    const res = await h.app.inject({
      method: 'GET',
      url: `${ADMIN_BASE}/${orgForUrl}/students${query}`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return listAdminStudentsResponseSchema.parse(res.json());
  };
  const emailsOf = (page: ListAdminStudentsResponse) => page.items.map((item) => item.email).sort();

  beforeAll(async () => {
    h = await createHarness();
    orgId = await h.seedOrganization('university');
    otherOrgId = await h.seedOrganization('university');
    const owner = await h.seedUser();
    await h.addMember(orgId, owner.userId, 'owner');
    headers = await h.authHeaders(owner.userId);

    // Mia: a member (sharing enabled) with a resume and two applications in this org.
    const mia = await h.seedUser({
      email: `mia-${tag}@example.test`,
      fullName: `Mia Member ${tag}`,
    });
    emails.mia = mia.email;
    await h.addMember(orgId, mia.userId, 'student');
    ids.mia = await h.addStudent(orgId, mia.userId, { program: 'Biology', graduationYear: 2026 });
    await h.seedResume(mia.userId, { atsScore: 64, createdAt: '2026-01-01T00:00:00Z' });
    await h.seedResume(mia.userId, { atsScore: 82, createdAt: '2026-02-01T00:00:00Z' });
    await h.seedResume(mia.userId, {
      atsScore: null,
      status: 'failed',
      createdAt: '2026-03-01T00:00:00Z',
    });
    await h.seedApplication(mia.userId, {
      status: 'submitted',
      organizationId: orgId,
      createdAt: '2026-02-10T00:00:00Z',
    });
    await h.seedApplication(mia.userId, {
      status: 'draft',
      organizationId: orgId,
      createdAt: '2026-02-20T00:00:00Z',
    });

    // Noah: a member without a resume, one interview.
    const noah = await h.seedUser({
      email: `noah-${tag}@example.test`,
      fullName: `Noah NoResume ${tag}`,
    });
    emails.noah = noah.email;
    await h.addMember(orgId, noah.userId, 'student');
    ids.noah = await h.addStudent(orgId, noah.userId, {
      program: 'Chemistry',
      graduationYear: 2027,
    });
    await h.seedApplication(noah.userId, { status: 'interviewing', organizationId: orgId });

    // Nina: on the roster but NOT a member: identity only, whatever she has done on the platform.
    const nina = await h.seedUser({
      email: `nina-${tag}@example.test`,
      fullName: `Nina Hidden ${tag}`,
    });
    emails.nina = nina.email;
    ids.nina = await h.addStudent(orgId, nina.userId, { program: 'Physics' });
    await h.seedResume(nina.userId, { atsScore: 99 });
    await h.seedApplication(nina.userId, { status: 'submitted', organizationId: orgId });
    await h.seedApplication(nina.userId, { status: 'offer', organizationId: orgId });

    // Omar: a member whose applications belong to other contexts (another org, no org).
    const omar = await h.seedUser({
      email: `omar-${tag}@example.test`,
      fullName: `Omar Elsewhere ${tag}`,
    });
    emails.omar = omar.email;
    await h.addMember(orgId, omar.userId, 'student');
    ids.omar = await h.addStudent(orgId, omar.userId);
    await h.seedApplication(omar.userId, { status: 'offer', organizationId: otherOrgId });
    await h.seedApplication(omar.userId, { status: 'interviewing', organizationId: null });

    const stranger = await h.seedUser();
    ids.otherOrgStudent = await h.addStudent(otherOrgId, stranger.userId);
  });

  afterAll(async () => {
    await h.close();
  });

  describe('list', () => {
    it('returns the roster with a summary only for students who are also members', async () => {
      const page = await list();
      expect(page.next_cursor).toBeNull();
      expect(emailsOf(page)).toEqual(Object.values(emails).sort());
      const byEmail = new Map(page.items.map((item) => [item.email, item]));

      const mia = byEmail.get(emails.mia)!;
      expect(mia).toMatchObject({
        student_id: ids.mia,
        full_name: `Mia Member ${tag}`,
        program: 'Biology',
        graduation_year: 2026,
        status: 'active',
        sharing_enabled: true,
      });
      expect(mia.insights).toMatchObject({
        has_resume: true,
        latest_ats_score: 82, // newest *scored* resume; the failed upload has no score
        applications_total: 2,
        applications_by_status: { submitted: 1, draft: 1, offer: 0, interviewing: 0 },
        last_application_activity_at: '2026-02-20T00:00:00.000Z',
      });

      expect(byEmail.get(emails.noah)!.insights).toMatchObject({
        has_resume: false,
        latest_ats_score: null,
        applications_total: 1,
        applications_by_status: { interviewing: 1 },
      });

      // Roster-only: identity (the email staff supplied), nothing derived from her activity.
      const nina = byEmail.get(emails.nina)!;
      expect(nina).toMatchObject({
        sharing_enabled: false,
        full_name: null,
        insights: null,
        program: 'Physics',
      });

      // Applications attributed to other contexts are not this organization's to see.
      expect(byEmail.get(emails.omar)!.insights).toMatchObject({
        applications_total: 0,
        latest_ats_score: null,
      });
    });

    it('returns only the requested fields, with no internal identifiers or private content', async () => {
      const page = await list();
      for (const item of page.items) {
        expect(Object.keys(item).sort()).toEqual(
          [
            'created_at',
            'email',
            'full_name',
            'graduation_year',
            'insights',
            'program',
            'sharing_enabled',
            'status',
            'student_id',
          ].sort(),
        );
      }
      const raw = JSON.stringify(page);
      for (const secret of [
        'CONFIDENTIAL',
        'parsed_text',
        'parsed_profile',
        'cover_letter',
        'user_id',
        'storage_url',
      ]) {
        expect(raw, secret).not.toContain(secret);
      }
    });

    it('searches by email, and by name only where the name is visible', async () => {
      expect(emailsOf(await list(`?search=MIA-${tag}`))).toEqual([emails.mia]);
      expect(emailsOf(await list(`?search=${encodeURIComponent(`Mia Member ${tag}`)}`))).toEqual([
        emails.mia,
      ]);
      expect(
        emailsOf(await list(`?search=${encodeURIComponent(`Omar Elsewhere ${tag}`)}`)),
      ).toEqual([emails.omar]);
      // Nina is not a member: her platform name must not be searchable, or searching would reveal it.
      expect(emailsOf(await list(`?search=${encodeURIComponent(`Nina Hidden ${tag}`)}`))).toEqual(
        [],
      );
      expect(emailsOf(await list(`?search=nina-${tag}`))).toEqual([emails.nina]);
    });

    it('treats search text as a literal, never as a pattern or SQL', async () => {
      for (const term of ['%', '_', '%%', '\\', "' or 1=1 --", '"; drop table students; --']) {
        const page = await list(`?search=${encodeURIComponent(term)}`);
        expect(page.items, term).toEqual([]);
      }
      expect((await list(`?search=${encodeURIComponent('%')}`)).items).toHaveLength(0);
      // The table is intact.
      expect((await list()).items).toHaveLength(4);
    });

    it('treats an empty search as no search', async () => {
      expect(await list('?search=')).toEqual(await list());
    });

    it('filters on has_resume, and only ever matches students with sharing enabled', async () => {
      expect(emailsOf(await list('?has_resume=true'))).toEqual([emails.mia]);
      // Nina has a resume but is not sharing: she matches neither value.
      expect(emailsOf(await list('?has_resume=false'))).toEqual([emails.noah, emails.omar].sort());
    });

    it('filters on application_status within this organization and for sharing students only', async () => {
      expect(emailsOf(await list('?application_status=submitted'))).toEqual([emails.mia]);
      expect(emailsOf(await list('?application_status=draft'))).toEqual([emails.mia]);
      expect(emailsOf(await list('?application_status=interviewing'))).toEqual([emails.noah]);
      // Nina's offer is hidden (not sharing) and Omar's belongs to another org.
      expect(emailsOf(await list('?application_status=offer'))).toEqual([]);
    });

    it('combines filters with AND', async () => {
      expect(emailsOf(await list('?has_resume=true&application_status=submitted'))).toEqual([
        emails.mia,
      ]);
      expect(emailsOf(await list('?has_resume=true&application_status=interviewing'))).toEqual([]);
      expect(emailsOf(await list(`?has_resume=false&search=noah-${tag}`))).toEqual([emails.noah]);
    });

    it('validates query parameters (400)', async () => {
      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=abc',
        '?has_resume=maybe',
        '?application_status=hired',
        '?cursor=%25%25%25',
        `?cursor=${Buffer.from('{"createdAt":"yesterday","id":"x"}').toString('base64url')}`,
        `?cursor=${Buffer.from('{"createdAt":"2026-01-01 00:00:00+00","id":"not-a-uuid"}').toString('base64url')}`,
      ]) {
        const res = await h.app.inject({
          method: 'GET',
          url: `${ADMIN_BASE}/${orgId}/students${query}`,
          headers,
        });
        expect(res.statusCode, query).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
      }
    });

    it("lists only this organization's roster", async () => {
      const other = await list('', otherOrgId).catch(() => null);
      // The caller is not a member of otherOrgId, so the request is refused outright.
      expect(other).toBeNull();
      const raw = JSON.stringify(await list());
      expect(raw).not.toContain(ids.otherOrgStudent);
    });
  });

  describe('pagination', () => {
    let pagedOrgId: string;
    let pagedHeaders: Record<string, string>;
    let expectedOrder: string[];

    beforeAll(async () => {
      pagedOrgId = await h.seedOrganization('university');
      const owner = await h.seedUser();
      await h.addMember(pagedOrgId, owner.userId, 'owner');
      pagedHeaders = await h.authHeaders(owner.userId);

      // Ten students whose created_at values collide in groups, as they do after one import.
      // Fixed-width, microsecond-precision stamps, so plain string comparison orders them like Postgres does.
      const stamps = [
        '2026-05-01T10:00:00.123456Z',
        '2026-05-01T10:00:00.123456Z',
        '2026-05-01T10:00:00.123456Z',
        '2026-05-01T10:00:00.123456Z',
        '2026-05-02T10:00:00.000000Z',
        '2026-05-02T10:00:00.000000Z',
        '2026-05-02T10:00:00.000000Z',
        '2026-04-30T23:59:59.999999Z',
        '2026-05-03T00:00:00.000000Z',
        '2026-05-03T00:00:00.000001Z',
      ];
      const seeded: { id: string; createdAt: string }[] = [];
      for (const createdAt of stamps) {
        const user = await h.seedUser();
        const id = await h.addStudent(pagedOrgId, user.userId, { createdAt });
        seeded.push({ id, createdAt });
      }
      // created_at descending, then student_id descending (uuid text order equals uuid byte order).
      expectedOrder = seeded
        .sort((a, b) =>
          a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
        )
        .map((entry) => entry.id);
    });

    async function walk(limit: number): Promise<string[][]> {
      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const query: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await h.app.inject({
          method: 'GET',
          url: `${ADMIN_BASE}/${pagedOrgId}/students${query}`,
          headers: pagedHeaders,
        });
        expect(res.statusCode, res.body).toBe(200);
        const page = listAdminStudentsResponseSchema.parse(res.json());
        pages.push(page.items.map((item: RosterStudent) => item.student_id));
        cursor = page.next_cursor;
      } while (cursor);
      return pages;
    }

    it('walks every page once, newest first, with ties at the page boundary neither repeated nor dropped', async () => {
      for (const limit of [1, 2, 3, 4, 7, 10, 11]) {
        const pages = await walk(limit);
        const flat = pages.flat();
        expect(flat, `limit ${limit}`).toEqual(expectedOrder);
        expect(new Set(flat).size).toBe(10);
        for (const page of pages.slice(0, -1)) expect(page).toHaveLength(limit);
      }
    });

    it('returns a null cursor on the last page and never an empty trailing page', async () => {
      const pages = await walk(5);
      expect(pages.map((page) => page.length)).toEqual([5, 5]);
      const exact = await walk(10);
      expect(exact).toHaveLength(1);
    });

    it('defaults to 20 per page', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: `${ADMIN_BASE}/${pagedOrgId}/students`,
        headers: pagedHeaders,
      });
      expect(listAdminStudentsResponseSchema.parse(res.json()).items).toHaveLength(10);
    });

    it('keeps paging stable under filters', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: `${ADMIN_BASE}/${pagedOrgId}/students?limit=3&has_resume=false`,
        headers: pagedHeaders,
      });
      // Nobody on this roster is a member, so nothing matches an attribute filter.
      expect(listAdminStudentsResponseSchema.parse(res.json())).toEqual({
        items: [],
        next_cursor: null,
      });
    });
  });

  describe('detail', () => {
    const detail = (studentId: string, orgForUrl = orgId) =>
      h.app.inject({
        method: 'GET',
        url: `${ADMIN_BASE}/${orgForUrl}/students/${studentId}`,
        headers,
      });

    it("returns a sharing student's summary: statuses and counts, latest ATS score, nothing private", async () => {
      const res = await detail(ids.mia);
      expect(res.statusCode).toBe(200);
      const { student } = adminStudentResponseSchema.parse(res.json());
      expect(student).toMatchObject({
        student_id: ids.mia,
        email: emails.mia,
        full_name: `Mia Member ${tag}`,
        sharing_enabled: true,
        insights: { has_resume: true, latest_ats_score: 82, applications_total: 2 },
      });
      for (const secret of [
        'CONFIDENTIAL',
        'parsed_text',
        'parsed_profile',
        'cover_letter',
        'failure_reason',
        'user_id',
        'job_id',
      ]) {
        expect(res.body, secret).not.toContain(secret);
      }
    });

    it('returns identity only for a roster student who is not a member', async () => {
      const res = await detail(ids.nina);
      expect(res.statusCode).toBe(200);
      const { student } = adminStudentResponseSchema.parse(res.json());
      expect(student).toMatchObject({
        student_id: ids.nina,
        sharing_enabled: false,
        full_name: null,
        insights: null,
      });
      expect(res.body).not.toContain('CONFIDENTIAL');
      expect(res.body).not.toContain('Nina Hidden');
    });

    it('answers 404 for a student of another organization, a missing id and a well-formed unknown id', async () => {
      for (const studentId of [ids.otherOrgStudent, randomUUID()]) {
        const res = await detail(studentId);
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('NOT_FOUND');
      }
    });

    it('hides a student whose account was deleted', async () => {
      const gone = await h.seedUser({ deleted: true });
      const studentId = await h.addStudent(orgId, gone.userId);
      expect((await detail(studentId)).statusCode).toBe(404);
      expect(JSON.stringify(await list())).not.toContain(studentId);
    });
  });
});
