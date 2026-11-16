import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@atlas/db';
import { accountExportSchema, ACCOUNT_EXPORT_VERSION, type AccountExport } from '@atlas/types';
import { DEFAULT_EXPORT_LIMITS, type ExportLimits } from '../src/lib/export-budget.js';
import {
  createHarness,
  seedUserData,
  testDatabaseUrl,
  type Harness,
  type SeededData,
  type SeededUser,
} from './privacy-support.js';

async function exportOf(h: Harness, userId: string) {
  return h.app.inject({ method: 'GET', url: '/v1/auth/me/export', headers: await h.authHeaders(userId) });
}

describe.skipIf(!testDatabaseUrl)('GET /v1/auth/me/export', () => {
  let h: Harness;
  let a: SeededUser;
  let b: SeededUser;
  let dataA: SeededData;
  let dataB: SeededData;
  let sharedOrg: string;
  let jobIds: string[];

  beforeAll(async () => {
    h = await createHarness();
    jobIds = await h.seedJobs(4);
    a = await h.seedUser();
    b = await h.seedUser();
    sharedOrg = await h.seedOrganization('university');
    await h.handle.db.insert(schema.organizationMembers).values([
      { organizationId: sharedOrg, userId: a.userId, role: 'student', permissions: { can_view_analytics: false } },
      { organizationId: sharedOrg, userId: b.userId, role: 'owner' },
    ]);
    dataA = await seedUserData(h, a, { label: 'A', jobIds: [jobIds[0]!, jobIds[1]!], organizationId: sharedOrg });
    dataB = await seedUserData(h, b, { label: 'B', jobIds: [jobIds[2]!, jobIds[3]!], organizationId: sharedOrg });
    // An active connection, to prove its bookkeeping is exported and its credential pointer is not.
    await h.handle.db.insert(schema.connectorAccounts).values({
      userId: a.userId,
      provider: 'lever',
      externalAccountId: `external-${randomUUID()}`,
      secretRef: dataA.markers.secretRef,
      scopes: ['jobs.read'],
      status: 'active',
      consentGrantedAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('downloads the caller\'s data as a JSON attachment that matches the published schema', async () => {
    const res = await exportOf(h, a.userId);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="atlas-data-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    // The file name carries no identity.
    expect(res.headers['content-disposition']).not.toContain(a.userId);
    expect(res.headers['content-disposition']).not.toContain(a.email);

    const doc: AccountExport = accountExportSchema.parse(JSON.parse(res.body));
    expect(doc.export_version).toBe(ACCOUNT_EXPORT_VERSION);
    expect(doc.truncated).toEqual([]);
    expect(doc.notes.length).toBeGreaterThan(0);

    expect(doc.user).toMatchObject({
      user_id: a.userId,
      email: a.email,
      full_name: a.fullName,
      auth_provider: 'password',
      primary_resume_id: dataA.resumeIds[0],
    });
  });

  it('includes profile, resumes with parsed text and profile, applications with events, messages, scores, memberships, roster and activity', async () => {
    const doc = accountExportSchema.parse(JSON.parse((await exportOf(h, a.userId)).body));

    expect(doc.resumes.map((resume) => resume.resume_id).sort()).toEqual([...dataA.resumeIds].sort());
    for (const resume of doc.resumes) {
      expect(resume.parsed_text).toContain(dataA.markers.parsedText);
      expect(resume.parsed_profile?.skills[0]?.name).toBe('postgresql');
      expect(resume.ats_report).not.toBeNull();
    }

    expect(doc.applications.map((application) => application.application_id).sort()).toEqual([...dataA.applicationIds].sort());
    for (const application of doc.applications) {
      expect(application.cover_letter).toContain(dataA.markers.coverLetter);
      expect(application.job.title).toMatch(/^Engineer \d$/);
      expect(application.job.company_name).toMatch(/^Privacy Test Co /);
      expect(application.events).toHaveLength(2);
      expect(application.events.map((event) => event.to_status)).toEqual(['draft', 'submitted']);
      expect(application.events[1]?.note).toContain(dataA.markers.eventNote);
    }

    expect(doc.messages.map((message) => message.message_id).sort()).toEqual([...dataA.messageIds].sort());
    expect(doc.messages.every((message) => message.body.includes(dataA.markers.messageBody))).toBe(true);
    // The contact is referenced by id only; its own details are not the user's data.
    expect(doc.messages.map((message) => message.contact_id)).toContain(dataA.contactId);

    expect(doc.job_scores.map((score) => score.job.job_id).sort()).toEqual([jobIds[0], jobIds[1]].sort());
    expect(doc.job_scores[0]!.score).toBeGreaterThanOrEqual(doc.job_scores[1]!.score);

    expect(doc.organization_memberships).toHaveLength(1);
    expect(doc.organization_memberships[0]).toMatchObject({
      organization: { organization_id: sharedOrg, type: 'university' },
      role: 'student',
      permissions: { can_view_analytics: false },
    });
    expect(doc.student_records).toHaveLength(1);
    expect(doc.student_records[0]).toMatchObject({ organization_id: sharedOrg, department: 'Computer Science', graduation_year: 2027 });

    // Activity attributed through the column and through the payload alone both count.
    expect(doc.activity_events.map((event) => event.event_id).sort()).toEqual(
      [dataA.eventIds.analyticsByColumn, dataA.eventIds.analyticsByPayload].sort(),
    );

    expect(doc.connected_accounts).toHaveLength(2);
    expect(doc.connected_accounts.map((account) => account.status).sort()).toEqual(['active', 'revoked']);
  });

  it('never exports credentials, internal pointers, embeddings or anything about another user', async () => {
    const res = await exportOf(h, a.userId);
    const body = res.body;

    // Secrets and pointers.
    for (const secret of [dataA.markers.passwordHash, dataA.markers.mfaSecret, dataA.markers.secretRef]) {
      expect(body).not.toContain(secret);
    }
    for (const key of dataA.storageKeys) expect(body).not.toContain(key);
    for (const forbiddenField of ['password_hash', 'mfa_secret', 'secret_ref', 'storage_url', 'content_hash', 'embedding', 'idempotency_key', 'failed_login_count', 'locked_until']) {
      expect(body, `field ${forbiddenField}`).not.toContain(`"${forbiddenField}"`);
    }
    const doc = JSON.parse(body) as { user: Record<string, unknown> };
    expect(Object.keys(doc.user).sort()).toEqual(
      ['auth_provider', 'created_at', 'email', 'email_verified', 'full_name', 'last_login_at', 'mfa_enabled', 'primary_resume_id', 'updated_at', 'user_id'].sort(),
    );

    // The other user in the same organization, using the same jobs and company: nothing of theirs.
    for (const theirs of [
      b.userId,
      b.email,
      b.fullName,
      dataB.markers.parsedText,
      dataB.markers.coverLetter,
      dataB.markers.messageBody,
      dataB.markers.eventNote,
      dataB.markers.passwordHash,
      dataB.markers.secretRef,
      ...dataB.resumeIds,
      ...dataB.applicationIds,
      ...dataB.messageIds,
      ...Object.values(dataB.eventIds),
    ]) {
      expect(body, `export of A must not contain ${theirs.slice(0, 30)}`).not.toContain(theirs);
    }
  });

  it('gives each caller their own data: the same route, a different token, a different file', async () => {
    const doc = accountExportSchema.parse(JSON.parse((await exportOf(h, b.userId)).body));

    expect(doc.user.user_id).toBe(b.userId);
    expect(doc.resumes.map((resume) => resume.resume_id).sort()).toEqual([...dataB.resumeIds].sort());
    expect(JSON.stringify(doc)).not.toContain(a.userId);
    expect(JSON.stringify(doc)).not.toContain(dataA.markers.parsedText);
  });

  it('cannot be pointed at another user: a user_id in the query changes nothing', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/auth/me/export?user_id=${b.userId}`,
      headers: await h.authHeaders(a.userId),
    });
    expect(res.statusCode).toBe(200);
    expect(accountExportSchema.parse(JSON.parse(res.body)).user.user_id).toBe(a.userId);
  });

  it('records the export in the audit log with the user id and counts only', async () => {
    const user = await h.seedUser();
    await exportOf(h, user.userId);

    const rows = await h.handle.sql<
      Array<{ actor_user_id: string; resource_type: string; resource_id: string; metadata: unknown; organization_id: string | null }>
    >`
      select actor_user_id, resource_type, resource_id, metadata, organization_id
        from public.audit_logs where action = 'account.export' and resource_id = ${user.userId}
    `;
    expect(rows).toEqual([
      { actor_user_id: user.userId, resource_type: 'user', resource_id: user.userId, metadata: { truncated_sections: 0 }, organization_id: null },
    ]);
    const lines = h.logOutput.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.find((line) => line.action === 'account.export' && line.user_id === user.userId)).toMatchObject({ audit: true });
    expect(h.logOutput.join('')).not.toContain(user.email);
  });

  it('requires authentication', async () => {
    for (const headers of [{}, { authorization: 'Bearer not-a-jwt' }]) {
      const res = await h.app.inject({ method: 'GET', url: '/v1/auth/me/export', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
      expect(res.body).not.toContain(a.email);
    }
  });

  it('answers 404 USER_NOT_FOUND for a valid token whose user no longer exists', async () => {
    const res = await exportOf(h, randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('USER_NOT_FOUND');
  });
});

describe.skipIf(!testDatabaseUrl)('GET /v1/auth/me/export size bounds', () => {
  let h: Harness;
  const limits: ExportLimits = {
    maxBytes: DEFAULT_EXPORT_LIMITS.maxBytes,
    rows: { ...DEFAULT_EXPORT_LIMITS.rows, job_scores: 2, resumes: 1, application_events: 3 },
  };

  beforeAll(async () => {
    h = await createHarness({ overrides: { exportLimits: limits } });
  });

  afterAll(async () => {
    await h.close();
  });

  it('cuts a section at its row cap and says so, rather than silently dropping rows', async () => {
    const user = await h.seedUser();
    const jobIds = await h.seedJobs(5);
    const data = await seedUserData(h, user, { label: 'cap', jobIds: jobIds.slice(0, 2) });
    // Three more scored jobs on top of the two the seed gave this user: five scores, cap of two.
    await h.handle.db.insert(schema.jobScores).values(
      jobIds.slice(2).map((jobId, index) => ({ jobId, userId: user.userId, score: 0.1 + index / 100, reasons: [], skillGaps: [], modelVersion: 'test-model' })),
    );

    const doc = accountExportSchema.parse(JSON.parse((await exportOf(h, user.userId)).body));

    expect(doc.job_scores).toHaveLength(2);
    // Highest scores first, so the cut removes the least relevant rows.
    expect(doc.job_scores.map((score) => score.score)).toEqual([0.9, 0.8].map((value) => expect.closeTo(value, 5)));
    expect(doc.resumes).toHaveLength(1);
    expect(data.resumeIds).toHaveLength(2);
    expect(doc.truncated).toEqual(
      expect.arrayContaining([
        { section: 'job_scores', returned: 2, reason: 'row_limit' },
        { section: 'resumes', returned: 1, reason: 'row_limit' },
      ]),
    );
    // Events are capped across all applications together: 4 exist, 3 allowed.
    expect(doc.applications.flatMap((application) => application.events)).toHaveLength(3);
    expect(doc.truncated).toContainEqual({ section: 'application_events', returned: 3, reason: 'row_limit' });
  });

  it('reports no truncation when everything fits', async () => {
    const user = await h.seedUser();
    const doc = accountExportSchema.parse(JSON.parse((await exportOf(h, user.userId)).body));
    expect(doc.truncated).toEqual([]);
  });
});

describe.skipIf(!testDatabaseUrl)('GET /v1/auth/me/export byte budget', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      overrides: { exportLimits: { maxBytes: 6_000, rows: DEFAULT_EXPORT_LIMITS.rows } },
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('stays within the byte budget by halving the heaviest sections, and lists every cut', async () => {
    const user = await h.seedUser();
    const jobIds = await h.seedJobs(2);
    await seedUserData(h, user, { label: 'budget', jobIds });

    const res = await exportOf(h, user.userId);

    expect(res.statusCode).toBe(200);
    expect(Buffer.byteLength(res.body, 'utf8')).toBeLessThanOrEqual(6_000);
    const doc = accountExportSchema.parse(JSON.parse(res.body));
    expect(doc.truncated.length).toBeGreaterThan(0);
    expect(doc.truncated.every((entry) => entry.reason === 'size_limit')).toBe(true);
    // The account itself is never cut.
    expect(doc.user.user_id).toBe(user.userId);
  });
});
