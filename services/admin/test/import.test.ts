import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@atlas/db';
import {
  ADMIN_MAX_IMPORT_ROWS,
  importStudentsResponseSchema,
  type ImportStudentsResponse,
} from '@atlas/types';
import {
  ADMIN_BASE,
  createHarness,
  importCsv,
  importJson,
  testDatabaseUrl,
  type Harness,
} from './support.js';

describe.skipIf(!testDatabaseUrl)('admin-service student import', () => {
  let h: Harness;
  let orgId: string;
  let adminHeaders: Record<string, string>;
  let adminId: string;

  const rosterOf = async (organizationId: string) =>
    h.handle.db
      .select()
      .from(schema.students)
      .where(eq(schema.students.organizationId, organizationId));

  const importAudits = async (organizationId: string) =>
    h.handle.db
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.organizationId, organizationId),
          eq(schema.auditLogs.action, 'admin.students.import'),
        ),
      );

  /** A fresh university with its own admin, so assertions on counts and audits are isolated. */
  async function freshOrg() {
    const organizationId = await h.seedOrganization('university');
    const admin = await h.seedUser();
    await h.addMember(organizationId, admin.userId, 'admin');
    return { organizationId, adminId: admin.userId, headers: await h.authHeaders(admin.userId) };
  }

  const report = (res: { statusCode: number; json: () => unknown }): ImportStudentsResponse => {
    expect(res.statusCode).toBe(200);
    return importStudentsResponseSchema.parse(res.json());
  };

  const accounted = (r: ImportStudentsResponse) =>
    r.created + r.updated + r.skipped + r.errors.length;

  beforeAll(async () => {
    h = await createHarness();
    orgId = await h.seedOrganization('university');
    const admin = await h.seedUser();
    adminId = admin.userId;
    await h.addMember(orgId, adminId, 'admin');
    adminHeaders = await h.authHeaders(adminId);
  });

  afterAll(async () => {
    await h.close();
  });

  it('creates roster entries for existing accounts, matched case-insensitively, and records the program and year', async () => {
    const org = await freshOrg();
    const ada = await h.seedUser({
      email: `Ada.Mixed-${randomUUID()}@Example.Test`,
      fullName: 'Ada Platform',
    });
    const grace = await h.seedUser();

    const res = await importJson(h, org.organizationId, org.headers, [
      {
        email: ada.email.toUpperCase(),
        full_name: 'Ada From The File',
        program: 'Mathematics',
        graduation_year: 2027,
        student_id: 'S-100',
      },
      { email: ` ${grace.email} `, full_name: 'Grace', graduation_year: '2026' },
    ]);

    const body = report(res);
    expect(body).toMatchObject({
      total_rows: 2,
      created: 2,
      updated: 0,
      skipped: 0,
      errors: [],
      ignored_fields: ['full_name', 'student_id'],
    });
    expect(accounted(body)).toBe(body.total_rows);

    const roster = await rosterOf(org.organizationId);
    expect(roster).toHaveLength(2);
    const adaRow = roster.find((row) => row.userId === ada.userId);
    expect(adaRow).toMatchObject({
      department: 'Mathematics',
      graduationYear: 2027,
      currentStatus: 'active',
    });
    expect(roster.find((row) => row.userId === grace.userId)).toMatchObject({
      department: null,
      graduationYear: 2026,
    });

    // The platform account is left alone: no rename, and no membership is granted by an import.
    const [account] = await h.handle.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.userId, ada.userId));
    expect(account?.fullName).toBe('Ada Platform');
    const members = await h.handle.db
      .select()
      .from(schema.organizationMembers)
      .where(eq(schema.organizationMembers.organizationId, org.organizationId));
    expect(members.map((member) => member.userId)).toEqual([org.adminId]);
  });

  it('imports a CSV body (BOM, CRLF, quoted fields, reordered header)', async () => {
    const org = await freshOrg();
    const one = await h.seedUser();
    const two = await h.seedUser();
    const csv =
      '﻿Full Name,Email,Program,graduation_year\r\n' +
      `"Lovelace, Ada ""Countess""",${one.email},"Computer Science, BSc",2028\r\n` +
      `Grace Hopper,${two.email},,\r\n`;

    const body = report(await importCsv(h, org.organizationId, org.headers, csv));

    expect(body).toMatchObject({ total_rows: 2, created: 2, errors: [] });
    const roster = await rosterOf(org.organizationId);
    expect(roster.find((row) => row.userId === one.userId)).toMatchObject({
      department: 'Computer Science, BSc',
      graduationYear: 2028,
    });
  });

  it('accounts for every row exactly once across created, updated, skipped and errors', async () => {
    const org = await freshOrg();
    const real = await h.seedUser();
    const second = await h.seedUser();
    const deleted = await h.seedUser({ deleted: true });
    const rows = [
      { email: real.email, full_name: 'Real' }, // 1 created
      { email: real.email.toUpperCase(), full_name: 'Real Again', program: 'Ignored dup' }, // 2 duplicate
      { email: 'not-an-email', full_name: 'Bad' }, // 3 error
      { email: `nobody-${randomUUID()}@example.test`, full_name: 'Ghost' }, // 4 no account
      { email: second.email, full_name: 'Second', graduation_year: 1800 }, // 5 error
      { email: deleted.email, full_name: 'Deleted' }, // 6 no account (soft-deleted)
      { email: second.email, full_name: 'Second', graduation_year: 2026 }, // 7 created
      { full_name: 'No Email' }, // 8 error
      { email: 'x@example.test', full_name: 'X', password: 'hunter2' }, // 9 error
    ];

    const body = report(await importJson(h, org.organizationId, org.headers, rows));

    expect(body).toMatchObject({
      total_rows: 9,
      created: 2,
      updated: 0,
      skipped: 3,
      skipped_breakdown: { unchanged: 0, duplicate_in_file: 1, no_platform_account: 2 },
    });
    expect(body.errors).toEqual([
      { row: 3, reason: 'INVALID_EMAIL' },
      { row: 5, reason: 'INVALID_GRADUATION_YEAR' },
      { row: 8, reason: 'MISSING_EMAIL' },
      { row: 9, reason: 'UNKNOWN_FIELD' },
    ]);
    expect(accounted(body)).toBe(9);
    // First occurrence wins: the duplicate's program was not applied.
    const roster = await rosterOf(org.organizationId);
    expect(roster.find((row) => row.userId === real.userId)?.department).toBeNull();
    expect(roster).toHaveLength(2);
  });

  it('never echoes submitted values back in row errors', async () => {
    const org = await freshOrg();
    const hostile = '<img src=x onerror=alert(1)>@evil.test';
    const res = await importJson(h, org.organizationId, org.headers, [
      { email: hostile, full_name: 'Mallory' },
      { email: 'ok@example.test', full_name: 'Line\nBreak' },
    ]);
    const body = report(res);
    expect(body.errors).toHaveLength(2);
    expect(res.body).not.toContain('onerror');
    expect(res.body).not.toContain('evil.test');
    expect(res.body).not.toContain('ok@example.test');
  });

  it('rejects structurally broken CSV with 400 and writes nothing', async () => {
    const org = await freshOrg();
    const user = await h.seedUser();
    const cases = [
      'email,full_name,secret\na@uni.test,A,x\n', // unknown column
      'email\na@uni.test\n', // missing required column
      'email,full_name\n', // no rows
      `email,full_name\n"${user.email},Unterminated\n`, // bad quoting
      '',
    ];
    for (const csv of cases) {
      const res = await importCsv(h, org.organizationId, org.headers, csv);
      expect(res.statusCode, csv).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(await rosterOf(org.organizationId)).toHaveLength(0);
    expect(await importAudits(org.organizationId)).toHaveLength(0);
  });

  it('rejects a JSON body with the wrong shape (400) and an unsupported content type (415)', async () => {
    const org = await freshOrg();
    for (const payload of [
      {},
      { rows: 'x' },
      { rows: [] },
      { rows: [{ email: 'a@b.test', full_name: 'A' }], extra: true },
    ]) {
      const res = await importJson(h, org.organizationId, org.headers, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }

    const text = await h.app.inject({
      method: 'POST',
      url: `${ADMIN_BASE}/${org.organizationId}/students/import`,
      headers: { ...org.headers, 'content-type': 'text/plain', 'idempotency-key': randomUUID() },
      payload: 'email,full_name',
    });
    expect(text.statusCode).toBe(415);
    expect(text.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const noType = await h.app.inject({
      method: 'POST',
      url: `${ADMIN_BASE}/${org.organizationId}/students/import`,
      headers: { ...org.headers, 'idempotency-key': randomUUID() },
    });
    expect(noType.statusCode).toBe(415);

    const empty = await h.app.inject({
      method: 'POST',
      url: `${ADMIN_BASE}/${org.organizationId}/students/import`,
      headers: {
        ...org.headers,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: '',
    });
    expect(empty.statusCode).toBe(400);
  });

  describe('row limit', () => {
    const ghostRows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        email: `ghost-${index}@example.test`,
        full_name: `Ghost ${index}`,
      }));

    it(`accepts exactly ${ADMIN_MAX_IMPORT_ROWS} rows in one request`, async () => {
      const org = await freshOrg();
      const res = await importJson(
        h,
        org.organizationId,
        org.headers,
        ghostRows(ADMIN_MAX_IMPORT_ROWS),
      );
      const body = report(res);
      expect(body).toMatchObject({
        total_rows: ADMIN_MAX_IMPORT_ROWS,
        skipped: ADMIN_MAX_IMPORT_ROWS,
      });
      expect(accounted(body)).toBe(ADMIN_MAX_IMPORT_ROWS);
    });

    it(`rejects ${ADMIN_MAX_IMPORT_ROWS + 1} JSON rows with 413 and does nothing`, async () => {
      const org = await freshOrg();
      const res = await importJson(
        h,
        org.organizationId,
        org.headers,
        ghostRows(ADMIN_MAX_IMPORT_ROWS + 1),
      );
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(await importAudits(org.organizationId)).toHaveLength(0);
    });

    it(`rejects ${ADMIN_MAX_IMPORT_ROWS + 1} CSV rows with 413`, async () => {
      const org = await freshOrg();
      const csv = `email,full_name\n${ghostRows(ADMIN_MAX_IMPORT_ROWS + 1)
        .map((row) => `${row.email},${row.full_name}`)
        .join('\n')}\n`;
      const res = await importCsv(h, org.organizationId, org.headers, csv);
      expect(res.statusCode).toBe(413);
      expect(await importAudits(org.organizationId)).toHaveLength(0);
    });

    it('rejects a body over the byte limit with 413', async () => {
      const org = await freshOrg();
      const res = await importCsv(
        h,
        org.organizationId,
        org.headers,
        `email,full_name\n${'x'.repeat(5 * 1024 * 1024)}`,
      );
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('idempotency', () => {
    it('requires an Idempotency-Key header (400 IDEMPOTENCY_KEY_REQUIRED)', async () => {
      const org = await freshOrg();
      const res = await h.app.inject({
        method: 'POST',
        url: `${ADMIN_BASE}/${org.organizationId}/students/import`,
        headers: { ...org.headers, 'content-type': 'application/json' },
        payload: JSON.stringify({ rows: [{ email: 'a@b.test', full_name: 'A' }] }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

      const short = await importJson(
        h,
        org.organizationId,
        org.headers,
        [{ email: 'a@b.test', full_name: 'A' }],
        'short',
      );
      expect(short.statusCode).toBe(400);
    });

    it('replays the stored result for the same key and body, without re-running or re-auditing', async () => {
      const org = await freshOrg();
      const student = await h.seedUser();
      const rows = [{ email: student.email, full_name: 'S', program: 'Physics' }];
      const key = `replay-${randomUUID()}`;

      const first = await importJson(h, org.organizationId, org.headers, rows, key);
      expect(report(first).created).toBe(1);
      expect(first.headers['idempotent-replayed']).toBeUndefined();

      // Change the data underneath: a genuine re-run would report "unchanged", the replay must not.
      await h.handle.db
        .delete(schema.students)
        .where(eq(schema.students.organizationId, org.organizationId));

      const second = await importJson(h, org.organizationId, org.headers, rows, key);
      expect(second.statusCode).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.json()).toEqual(first.json());
      // Replayed, not re-executed: the deleted row stays deleted and there is one audit entry.
      expect(await rosterOf(org.organizationId)).toHaveLength(0);
      expect(await importAudits(org.organizationId)).toHaveLength(1);
    });

    it('rejects the same key with a different body (409 IDEMPOTENCY_KEY_REUSED)', async () => {
      const org = await freshOrg();
      const key = `reuse-${randomUUID()}`;
      const first = await importJson(
        h,
        org.organizationId,
        org.headers,
        [{ email: 'a@b.test', full_name: 'A' }],
        key,
      );
      expect(first.statusCode).toBe(200);

      const second = await importJson(
        h,
        org.organizationId,
        org.headers,
        [{ email: 'c@d.test', full_name: 'C' }],
        key,
      );
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await importAudits(org.organizationId)).toHaveLength(1);
    });

    it('treats a CSV and a JSON body with the same rows as the same request', async () => {
      const org = await freshOrg();
      const key = `format-${randomUUID()}`;
      const rows = [{ email: 'a@b.test', full_name: 'A' }];
      const json = await importJson(h, org.organizationId, org.headers, rows, key);
      const csv = await importCsv(
        h,
        org.organizationId,
        org.headers,
        'email,full_name\na@b.test,A\n',
        key,
      );
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['idempotent-replayed']).toBe('true');
      expect(csv.json()).toEqual(json.json());
    });

    it('scopes keys to the caller and the organization', async () => {
      const first = await freshOrg();
      const second = await freshOrg();
      const key = `shared-${randomUUID()}`;
      const rows = [{ email: 'a@b.test', full_name: 'A' }];

      const a = await importJson(h, first.organizationId, first.headers, rows, key);
      const b = await importJson(
        h,
        second.organizationId,
        second.headers,
        [{ email: 'z@y.test', full_name: 'Z' }],
        key,
      );
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(b.headers['idempotent-replayed']).toBeUndefined();

      // Another admin of the same org does not collide with, or read, the first admin's key.
      const colleague = await h.seedUser();
      await h.addMember(first.organizationId, colleague.userId, 'owner');
      const c = await importJson(
        h,
        first.organizationId,
        await h.authHeaders(colleague.userId),
        [{ email: 'q@r.test', full_name: 'Q' }],
        key,
      );
      expect(c.statusCode).toBe(200);
      expect(c.headers['idempotent-replayed']).toBeUndefined();
    });

    it('runs two concurrent requests with one key once', async () => {
      const org = await freshOrg();
      const users = await Promise.all(Array.from({ length: 5 }, () => h.seedUser()));
      const rows = users.map((user) => ({ email: user.email, full_name: 'Concurrent' }));
      const key = `race-${randomUUID()}`;

      const [a, b] = await Promise.all([
        importJson(h, org.organizationId, org.headers, rows, key),
        importJson(h, org.organizationId, org.headers, rows, key),
      ]);

      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(a.json()).toEqual(b.json());
      expect([a, b].filter((res) => res.headers['idempotent-replayed'] === 'true')).toHaveLength(1);
      expect(report(a).created).toBe(5);
      expect(await rosterOf(org.organizationId)).toHaveLength(5);
      expect(await importAudits(org.organizationId)).toHaveLength(1);
    });

    it('does not keep the key when the import fails, so the client can retry', async () => {
      const org = await freshOrg();
      const key = `retry-${randomUUID()}`;
      const bad = await importCsv(h, org.organizationId, org.headers, 'email,wrong\n', key);
      expect(bad.statusCode).toBe(400);
      const stored = await h.handle.sql`select 1 from idempotency_keys where key = ${key}`;
      expect(stored).toHaveLength(0);
    });
  });

  describe('re-importing', () => {
    it('is idempotent across keys: the second run changes nothing and reports unchanged', async () => {
      const org = await freshOrg();
      const users = await Promise.all([h.seedUser(), h.seedUser(), h.seedUser()]);
      const rows = users.map((user, index) => ({
        email: user.email,
        full_name: `S${index}`,
        program: 'History',
        graduation_year: 2026,
      }));

      const first = report(await importJson(h, org.organizationId, org.headers, rows));
      const before = await rosterOf(org.organizationId);
      const second = report(await importJson(h, org.organizationId, org.headers, rows));
      const after = await rosterOf(org.organizationId);

      expect(first.created).toBe(3);
      expect(second).toMatchObject({
        created: 0,
        updated: 0,
        skipped: 3,
        skipped_breakdown: { unchanged: 3, duplicate_in_file: 0, no_platform_account: 0 },
      });
      expect(after).toEqual(before);
    });

    it('updates changed values, keeps stored values when a cell is blank, and never duplicates', async () => {
      const org = await freshOrg();
      const [a, b, c] = await Promise.all([h.seedUser(), h.seedUser(), h.seedUser()]);
      report(
        await importJson(h, org.organizationId, org.headers, [
          { email: a.email, full_name: 'A', program: 'Law', graduation_year: 2026 },
          { email: b.email, full_name: 'B', program: 'Law', graduation_year: 2026 },
          { email: c.email, full_name: 'C', program: 'Law', graduation_year: 2026 },
        ]),
      );

      const second = report(
        await importJson(h, org.organizationId, org.headers, [
          { email: a.email, full_name: 'A', program: 'Medicine' }, // program changes, year kept
          { email: b.email, full_name: 'B', graduation_year: 2029 }, // year changes, program kept
          { email: c.email, full_name: 'C', program: '', graduation_year: '' }, // blanks clear nothing
        ]),
      );

      expect(second).toMatchObject({
        created: 0,
        updated: 2,
        skipped: 1,
        skipped_breakdown: { unchanged: 1 },
      });
      const roster = await rosterOf(org.organizationId);
      expect(roster).toHaveLength(3);
      const byUser = new Map(roster.map((row) => [row.userId, row]));
      expect(byUser.get(a.userId)).toMatchObject({ department: 'Medicine', graduationYear: 2026 });
      expect(byUser.get(b.userId)).toMatchObject({ department: 'Law', graduationYear: 2029 });
      expect(byUser.get(c.userId)).toMatchObject({ department: 'Law', graduationYear: 2026 });
    });

    it('keeps rosters per organization: the same account can be on two rosters', async () => {
      const one = await freshOrg();
      const two = await freshOrg();
      const shared = await h.seedUser();
      const rows = [{ email: shared.email, full_name: 'Shared', program: 'Chemistry' }];
      expect(report(await importJson(h, one.organizationId, one.headers, rows)).created).toBe(1);
      expect(report(await importJson(h, two.organizationId, two.headers, rows)).created).toBe(1);
      expect(await rosterOf(one.organizationId)).toHaveLength(1);
      expect(await rosterOf(two.organizationId)).toHaveLength(1);
    });

    it('handles a large mixed batch in a bounded number of statements', async () => {
      const org = await freshOrg();
      const existing = await Promise.all(Array.from({ length: 30 }, () => h.seedUser()));
      const rows = [
        ...existing.map((user) => ({ email: user.email, full_name: 'E', program: 'Bulk' })),
        ...Array.from({ length: 2_000 }, (_, i) => ({
          email: `bulk-ghost-${i}@example.test`,
          full_name: `G${i}`,
        })),
      ];
      const started = performance.now();
      const body = report(await importJson(h, org.organizationId, org.headers, rows));
      expect(body).toMatchObject({ created: 30, skipped: 2_000, total_rows: 2_030 });
      expect(performance.now() - started).toBeLessThan(10_000);
    });
  });

  describe('audit trail', () => {
    it('writes one entry per import with actor, organization and counts only', async () => {
      const org = await freshOrg();
      const student = await h.seedUser();
      const res = await importJson(h, org.organizationId, org.headers, [
        { email: student.email, full_name: 'Audit Subject', program: 'Secret Program' },
        { email: 'bad', full_name: 'Bad' },
      ]);
      expect(res.statusCode).toBe(200);

      const audits = await importAudits(org.organizationId);
      expect(audits).toHaveLength(1);
      const audit = audits[0]!;
      expect(audit).toMatchObject({
        organizationId: org.organizationId,
        actorUserId: org.adminId,
        resourceType: 'student_roster',
        resourceId: org.organizationId,
      });
      expect(audit.traceId).toBeTruthy();
      expect(audit.metadata).toEqual({
        source: 'json',
        total_rows: 2,
        created: 1,
        updated: 0,
        skipped: 0,
        errors: 1,
      });
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain(student.email);
      expect(serialized).not.toContain('Audit Subject');
      expect(serialized).not.toContain('Secret Program');
      expect(serialized).not.toContain('@');
    });

    it('records the source format for CSV imports', async () => {
      const org = await freshOrg();
      await importCsv(
        h,
        org.organizationId,
        org.headers,
        'email,full_name\nnobody@example.test,N\n',
      );
      const [audit] = await importAudits(org.organizationId);
      expect(audit?.metadata).toMatchObject({ source: 'csv', total_rows: 1, skipped: 1 });
    });

    it('does not audit a request that was refused', async () => {
      const org = await freshOrg();
      const member = await h.seedUser();
      await h.addMember(org.organizationId, member.userId, 'member');
      await importJson(h, org.organizationId, await h.authHeaders(member.userId), [
        { email: 'a@b.test', full_name: 'A' },
      ]);
      expect(await importAudits(org.organizationId)).toHaveLength(0);
    });
  });

  it('keeps the shared admin used by this suite working (sanity)', async () => {
    const res = await importJson(h, orgId, adminHeaders, [
      { email: 'sanity@example.test', full_name: 'Sanity' },
    ]);
    expect(report(res).skipped).toBe(1);
    expect(adminId).toBeTruthy();
  });
});
