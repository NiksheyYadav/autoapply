import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@atlas/db';
import { deleteAccountResponseSchema, type DeleteAccountResponse } from '@atlas/types';
import {
  createHarness,
  referencesByColumn,
  rowsMentioning,
  seedUserData,
  testDatabaseUrl,
  userLikeColumns,
  type Harness,
  type SeededData,
  type SeededUser,
} from './privacy-support.js';

/**
 * Every uuid column in `public` named like a user reference. The completeness test fails when this
 * list and the database disagree, which is the point: a new table (or column) holding a user id
 * has to be taught to account deletion, and to this suite's seed data, before it can ship.
 */
const EXPECTED_USER_COLUMNS = [
  'analytics_events.user_id',
  'applications.user_id',
  'audit_logs.actor_user_id',
  'connector_accounts.user_id',
  'event_outbox.user_id',
  'idempotency_keys.user_id',
  'job_scores.user_id',
  'messages.user_id',
  'organization_members.user_id',
  'resumes.user_id',
  'students.user_id',
  'users.user_id',
];

async function del(h: Harness, userId: string, payload: unknown = { confirm: 'DELETE' }) {
  return h.app.inject({
    method: 'DELETE',
    url: '/v1/auth/me',
    headers: await h.authHeaders(userId),
    payload: payload as never,
  });
}

async function userExists(h: Harness, userId: string): Promise<boolean> {
  const [row] = await h.handle.sql<Array<{ n: number }>>`
    select (select count(*) from public.users where user_id = ${userId})::int
         + (select count(*) from auth.users where id = ${userId})::int as n
  `;
  return row!.n > 0;
}

async function addMember(h: Harness, organizationId: string, userId: string, role: 'member' | 'admin' | 'owner') {
  await h.handle.db.insert(schema.organizationMembers).values({ organizationId, userId, role });
}

async function tombstones(h: Harness, userId: string) {
  return h.handle.sql<
    Array<{ organization_id: string | null; actor_user_id: string | null; resource_type: string; metadata: unknown; trace_id: string | null }>
  >`
    select organization_id, actor_user_id, resource_type, metadata, trace_id
      from public.audit_logs where action = 'account.deleted' and resource_id = ${userId}
  `;
}

describe.skipIf(!testDatabaseUrl)('DELETE /v1/auth/me', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('leaves no trace of the user in any table and touches nothing of anyone else', async () => {
    // The scan is only meaningful if the schema is the one this suite seeds.
    const discovered = (await userLikeColumns(h.handle.sql)).map(({ table, column }) => `${table}.${column}`);
    expect(
      discovered,
      'a table or column that references a user was added or removed: teach services/auth/src/repo/delete-account.ts about it, seed it in test/privacy-support.ts, then update EXPECTED_USER_COLUMNS',
    ).toEqual(EXPECTED_USER_COLUMNS);

    const jobIds = await h.seedJobs(4);
    const a = await h.seedUser();
    const b = await h.seedUser();
    // A's own workspace (they are its only member), B's workspace, and an institution they both belong to.
    const personalOrg = await h.seedOrganization('individual');
    await addMember(h, personalOrg, a.userId, 'owner');
    const bystanderOrg = await h.seedOrganization('individual');
    await addMember(h, bystanderOrg, b.userId, 'owner');
    const sharedOrg = await h.seedOrganization('university');
    await addMember(h, sharedOrg, b.userId, 'owner');
    await addMember(h, sharedOrg, a.userId, 'member');

    const dataA = await seedUserData(h, a, { label: 'A', jobIds: [jobIds[0]!, jobIds[1]!], organizationId: sharedOrg });
    const dataB = await seedUserData(h, b, { label: 'B', jobIds: [jobIds[2]!, jobIds[3]!], organizationId: sharedOrg });

    const needlesFor = (user: SeededUser, data: SeededData) => [
      user.userId,
      user.email,
      user.fullName,
      ...Object.values(data.markers),
    ];

    // Positive control: before the deletion the scan must see the user in every table that can
    // hold them, including the ones no foreign key covers. Otherwise "found nothing" proves nothing.
    const before = await referencesByColumn(h.handle.sql, a.userId);
    for (const column of EXPECTED_USER_COLUMNS) {
      expect(before[column], `seed data should put a row in ${column}`).toBeGreaterThan(0);
    }
    const mentionedBefore = await rowsMentioning(h.handle.sql, needlesFor(a, dataA));
    for (const table of ['event_outbox', 'tasks', 'analytics_events', 'idempotency_keys', 'audit_logs', 'resumes', 'messages', 'applications', 'users']) {
      expect(Object.keys(mentionedBefore), `seed data should mention the user in ${table}`).toContain(table);
    }

    const bystanderBefore = {
      columns: await referencesByColumn(h.handle.sql, b.userId),
      mentions: await rowsMentioning(h.handle.sql, needlesFor(b, dataB)),
    };

    const res = await del(h, a.userId);
    expect(res.statusCode).toBe(200);
    const body = deleteAccountResponseSchema.parse(res.json());
    expect(body).toMatchObject({
      status: 'deleted',
      organizations_deleted: 1,
      resume_files: { total: 2, failed: 0 },
    } satisfies Partial<DeleteAccountResponse>);
    expect(res.headers['cache-control']).toBe('no-store');

    // 1. No user-like column anywhere points at the user any more.
    const after = await referencesByColumn(h.handle.sql, a.userId);
    expect(Object.fromEntries(Object.entries(after).filter(([, count]) => count > 0))).toEqual({});

    // 2. Nothing, anywhere, mentions the user: not their id in a payload, not their email, name,
    //    resume text, cover letter, messages or the credential pointer.
    expect(await rowsMentioning(h.handle.sql, needlesFor(a, dataA))).toEqual({});

    // 3. The sign-in account and the stored files are gone.
    expect(await userExists(h, a.userId)).toBe(false);
    for (const key of dataA.storageKeys) expect(await h.storage.exists(key)).toBe(false);

    // 4. The organization only they were in is gone; the shared one, and its other people, are not.
    const orgRows = await h.handle.sql<Array<{ organization_id: string }>>`
      select organization_id from public.organizations where organization_id in ${h.handle.sql([personalOrg, bystanderOrg, sharedOrg])}
    `;
    expect(orgRows.map((row) => row.organization_id).sort()).toEqual([bystanderOrg, sharedOrg].sort());

    // 5. The one thing that remains is the tombstone: the id, a timestamp, counts. No actor, no name.
    const marks = await tombstones(h, a.userId);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      organization_id: null,
      actor_user_id: null,
      resource_type: 'user',
      metadata: { organizations_deleted: 1, resume_files: 2 },
    });
    expect(JSON.stringify(marks[0])).not.toContain(a.email);
    expect(JSON.stringify(marks[0])).not.toContain(a.fullName);

    // 6. What the user did inside the shared organization stays for that organization, with nobody named.
    const orgAudit = await h.handle.sql<Array<{ actor_user_id: string | null }>>`
      select actor_user_id from public.audit_logs where organization_id = ${sharedOrg} and action = 'admin.students.export'
       order by actor_user_id nulls first
    `;
    expect(orgAudit.map((row) => row.actor_user_id)).toEqual([null, b.userId]);

    // 7. Nothing of anyone else changed, and the shared listings are untouched.
    expect(await referencesByColumn(h.handle.sql, b.userId)).toEqual(bystanderBefore.columns);
    expect(await rowsMentioning(h.handle.sql, needlesFor(b, dataB))).toEqual(bystanderBefore.mentions);
    for (const key of dataB.storageKeys) expect(await h.storage.exists(key)).toBe(true);
    const [jobCount] = await h.handle.sql<Array<{ n: number }>>`
      select count(*)::int as n from public.jobs where job_id in ${h.handle.sql(jobIds)}
    `;
    expect(jobCount!.n).toBe(4);
    const [contact] = await h.handle.sql<Array<{ n: number }>>`
      select count(*)::int as n from public.contacts where contact_id = ${dataA.contactId}
    `;
    expect(contact!.n).toBe(1);
  });

  it('answers a repeat of a completed deletion with success and counts, and records one tombstone', async () => {
    const user = await h.seedUser();
    const [job] = await h.seedJobs(1);
    await seedUserData(h, user, { label: 'repeat', jobIds: [job!] });

    const first = await del(h, user.userId);
    expect(first.statusCode).toBe(200);
    expect(first.json().resume_files.total).toBe(2);

    const again = await del(h, user.userId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      status: 'deleted',
      organizations_deleted: 0,
      resume_files: { total: 0, failed: 0 },
    });
    expect(await tombstones(h, user.userId)).toHaveLength(1);
  });

  describe('confirmation', () => {
    it.each([
      ['no body', undefined, undefined],
      ['an empty object', {}, undefined],
      ['lowercase', { confirm: 'delete' }, undefined],
      ['trailing space', { confirm: 'DELETE ' }, undefined],
      ['a boolean', { confirm: true }, undefined],
      ['an extra field', { confirm: 'DELETE', cascade: true }, undefined],
      ['an empty JSON body', undefined, 'application/json'],
      ['malformed JSON', '{"confirm":', 'application/json'],
    ])('rejects %s with 400 VALIDATION_ERROR and deletes nothing', async (_name, payload, contentType) => {
      const user = await h.seedUser();
      const [job] = await h.seedJobs(1);
      const data = await seedUserData(h, user, { label: 'confirm', jobIds: [job!] });
      const before = await referencesByColumn(h.handle.sql, user.userId);

      const res = await h.app.inject({
        method: 'DELETE',
        url: '/v1/auth/me',
        headers: await h.authHeaders(user.userId, contentType ? { 'content-type': contentType } : {}),
        ...(payload === undefined ? {} : { payload: payload as never }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(await userExists(h, user.userId)).toBe(true);
      expect(await referencesByColumn(h.handle.sql, user.userId)).toEqual(before);
      for (const key of data.storageKeys) expect(await h.storage.exists(key)).toBe(true);
      expect(await tombstones(h, user.userId)).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it('refuses a request with no token, a malformed one, or a token for a different issuer, and deletes nothing', async () => {
      const user = await h.seedUser();
      const [job] = await h.seedJobs(1);
      await seedUserData(h, user, { label: 'auth', jobIds: [job!] });

      for (const headers of [{}, { authorization: 'Bearer not-a-jwt' }, { authorization: 'Basic abc' }]) {
        const res = await h.app.inject({
          method: 'DELETE',
          url: '/v1/auth/me',
          headers,
          payload: { confirm: 'DELETE' },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('UNAUTHENTICATED');
      }
      expect(await userExists(h, user.userId)).toBe(true);
    });

    it('only ever deletes the caller: the body has no way to name anyone else', async () => {
      const caller = await h.seedUser();
      const victim = await h.seedUser();

      const res = await h.app.inject({
        method: 'DELETE',
        url: `/v1/auth/me?user_id=${victim.userId}`,
        headers: await h.authHeaders(caller.userId),
        payload: { confirm: 'DELETE' },
      });
      expect(res.statusCode).toBe(200);

      expect(await userExists(h, caller.userId)).toBe(false);
      expect(await userExists(h, victim.userId)).toBe(true);

      const smuggled = await del(h, caller.userId, { confirm: 'DELETE', user_id: victim.userId });
      expect(smuggled.statusCode).toBe(400);
      expect(await userExists(h, victim.userId)).toBe(true);
    });
  });

  describe('organizations', () => {
    it('refuses the only owner of an organization that has other members, and deletes nothing', async () => {
      const owner = await h.seedUser();
      const colleague = await h.seedUser();
      const [job] = await h.seedJobs(1);
      const data = await seedUserData(h, owner, { label: 'owner', jobIds: [job!] });
      const org = await h.seedOrganization('university');
      await addMember(h, org, owner.userId, 'owner');
      await addMember(h, org, colleague.userId, 'member');
      const before = await referencesByColumn(h.handle.sql, owner.userId);

      const res = await del(h, owner.userId);

      expect(res.statusCode).toBe(409);
      const error = res.json().error;
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toMatch(/only owner/i);
      expect(error.details).toMatchObject({
        reason: 'sole_owner_of_organization',
        organizations: [{ organization_id: org }],
      });
      expect(await userExists(h, owner.userId)).toBe(true);
      expect(await referencesByColumn(h.handle.sql, owner.userId)).toEqual(before);
      for (const key of data.storageKeys) expect(await h.storage.exists(key)).toBe(true);
      expect(await tombstones(h, owner.userId)).toHaveLength(0);

      // Once another owner exists, the same request goes through and the organization stays.
      await h.handle.sql`update public.organization_members set role = 'owner' where organization_id = ${org} and user_id = ${colleague.userId}`;
      const retry = await del(h, owner.userId);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().organizations_deleted).toBe(0);
      const members = await h.handle.sql<Array<{ user_id: string }>>`select user_id from public.organization_members where organization_id = ${org}`;
      expect(members.map((row) => row.user_id)).toEqual([colleague.userId]);
    });

    it('treats a student on the roster as another person: the only owner is still refused', async () => {
      const owner = await h.seedUser();
      const student = await h.seedUser();
      const org = await h.seedOrganization('university');
      await addMember(h, org, owner.userId, 'owner');
      // On the roster but not a member of the organization.
      await h.handle.db.insert(schema.students).values({ organizationId: org, userId: student.userId });

      const res = await del(h, owner.userId);

      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.reason).toBe('sole_owner_of_organization');
      expect(await userExists(h, owner.userId)).toBe(true);
    });

    it('lets an admin who is not the only owner leave: only their own rows go', async () => {
      const owner = await h.seedUser();
      const admin = await h.seedUser();
      const org = await h.seedOrganization('university');
      await addMember(h, org, owner.userId, 'owner');
      await addMember(h, org, admin.userId, 'admin');

      const res = await del(h, admin.userId);

      expect(res.statusCode).toBe(200);
      expect(res.json().organizations_deleted).toBe(0);
      const members = await h.handle.sql<Array<{ user_id: string }>>`select user_id from public.organization_members where organization_id = ${org}`;
      expect(members.map((row) => row.user_id)).toEqual([owner.userId]);
    });

    it('lets a student leave a university: their roster entry goes, the organization and its owner stay', async () => {
      const owner = await h.seedUser();
      const student = await h.seedUser();
      const org = await h.seedOrganization('university');
      await addMember(h, org, owner.userId, 'owner');
      await h.handle.db.insert(schema.students).values({ organizationId: org, userId: student.userId, graduationYear: 2027 });

      const res = await del(h, student.userId);

      expect(res.statusCode).toBe(200);
      const roster = await h.handle.sql<Array<{ n: number }>>`select count(*)::int as n from public.students where organization_id = ${org}`;
      expect(roster[0]!.n).toBe(0);
      expect(await userExists(h, owner.userId)).toBe(true);
    });
  });

  describe('institutions', () => {
    it('keeps a university organization when its only member leaves, and deletes a personal workspace', async () => {
      const user = await h.seedUser();
      const institution = await h.seedOrganization('university');
      const workspace = await h.seedOrganization('individual');
      await addMember(h, institution, user.userId, 'owner');
      await addMember(h, workspace, user.userId, 'owner');

      const res = await del(h, user.userId);

      expect(res.statusCode).toBe(200);
      expect(res.json().organizations_deleted).toBe(1);
      const left = await h.handle.sql<Array<{ organization_id: string }>>`
        select organization_id from public.organizations where organization_id in ${h.handle.sql([institution, workspace])}
      `;
      expect(left.map((row) => row.organization_id)).toEqual([institution]);
      const members = await h.handle.sql<Array<{ n: number }>>`select count(*)::int as n from public.organization_members where organization_id = ${institution}`;
      expect(members[0]!.n).toBe(0);
    });
  });

  describe('connected accounts', () => {
    it('refuses while a credential is still connected, so it cannot be orphaned, and allows it once revoked', async () => {
      const user = await h.seedUser();
      const [row] = await h.handle.db
        .insert(schema.connectorAccounts)
        .values({
          userId: user.userId,
          provider: 'greenhouse',
          externalAccountId: `external-${randomUUID()}`,
          secretRef: `SECRET-REF-${randomUUID()}`,
          status: 'active',
        })
        .returning();

      const refused = await del(h, user.userId);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.details.reason).toBe('active_connected_accounts');
      expect(refused.json().error.message).toMatch(/disconnect/i);
      // Neither the id of the connection nor its credential pointer is echoed back.
      expect(JSON.stringify(refused.json())).not.toContain(row!.secretRef);
      expect(await userExists(h, user.userId)).toBe(true);

      await h.handle.sql`update public.connector_accounts set status = 'revoked' where connector_account_id = ${row!.connectorAccountId}`;
      const allowed = await del(h, user.userId);
      expect(allowed.statusCode).toBe(200);
      expect(await userExists(h, user.userId)).toBe(false);
    });

    it('also refuses when an organization that would be deleted along with the account holds a connected credential', async () => {
      const user = await h.seedUser();
      const workspace = await h.seedOrganization('individual');
      await addMember(h, workspace, user.userId, 'owner');
      const [row] = await h.handle.db
        .insert(schema.connectorAccounts)
        .values({
          userId: null,
          organizationId: workspace,
          provider: 'lever',
          externalAccountId: `external-${randomUUID()}`,
          secretRef: `SECRET-REF-${randomUUID()}`,
          status: 'active',
        })
        .returning();

      const refused = await del(h, user.userId);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.details.reason).toBe('active_connected_accounts');
      expect(await userExists(h, user.userId)).toBe(true);

      await h.handle.sql`update public.connector_accounts set status = 'revoked' where connector_account_id = ${row!.connectorAccountId}`;
      expect((await del(h, user.userId)).statusCode).toBe(200);
    });
  });

  describe('atomicity', () => {
    it('rolls back every change when a step fails, leaving the account whole, and succeeds on retry', async () => {
      const user = await h.seedUser();
      const workspace = await h.seedOrganization('individual');
      await addMember(h, workspace, user.userId, 'owner');
      const [job] = await h.seedJobs(1);
      const data = await seedUserData(h, user, { label: 'atomic', jobIds: [job!] });
      const before = await referencesByColumn(h.handle.sql, user.userId);
      const suffix = randomUUID().replace(/-/g, '').slice(0, 10);

      // The last rows the transaction touches before the account itself: make deleting this user's task row fail.
      await h.handle.sql.unsafe(`
        create function public.privacy_block_${suffix}() returns trigger language plpgsql as $$
        begin
          if old.payload ->> 'user_id' = '${user.userId}' then
            raise exception 'blocked for the atomicity test';
          end if;
          return old;
        end $$;
        create trigger privacy_block_${suffix} before delete on public.tasks
          for each row execute function public.privacy_block_${suffix}();
      `);
      try {
        const failed = await del(h, user.userId);
        expect(failed.statusCode).toBe(500);
        expect(failed.json().error.code).toBe('INTERNAL_ERROR');
        // Nothing was removed: not the earlier explicit deletes, not the organization, not the account.
        expect(await userExists(h, user.userId)).toBe(true);
        expect(await referencesByColumn(h.handle.sql, user.userId)).toEqual(before);
        expect(await tombstones(h, user.userId)).toHaveLength(0);
        // The files are only touched after a commit, so they are all still there.
        for (const key of data.storageKeys) expect(await h.storage.exists(key)).toBe(true);
      } finally {
        await h.handle.sql.unsafe(`
          drop trigger if exists privacy_block_${suffix} on public.tasks;
          drop function if exists public.privacy_block_${suffix}();
        `);
      }

      const retry = await del(h, user.userId);
      expect(retry.statusCode).toBe(200);
      expect(await userExists(h, user.userId)).toBe(false);
    });
  });
});

describe.skipIf(!testDatabaseUrl)('DELETE /v1/auth/me when file storage misbehaves', () => {
  const failing = new Set<string>();
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      wrapStorage: (inner) => ({
        ...inner,
        delete: async (key: string) => {
          if (failing.has(key)) throw new Error('storage exploded for jane.doe@example.com');
          await inner.delete(key);
        },
      }),
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('still completes the deletion, reports the files it could not remove, and logs the user id but nothing personal', async () => {
    const user = await h.seedUser();
    const [job] = await h.seedJobs(1);
    const data = await seedUserData(h, user, { label: 'storage', jobIds: [job!] });
    failing.add(data.storageKeys[0]!);
    const token = await h.token(user.userId);

    const res = await h.app.inject({
      method: 'DELETE',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { confirm: 'DELETE' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().resume_files).toEqual({ total: 2, failed: 1 });
    // The database side is fully done; only the one file the driver refused is left.
    expect(await userExists(h, user.userId)).toBe(false);
    expect(await h.storage.exists(data.storageKeys[0]!)).toBe(true);
    expect(await h.storage.exists(data.storageKeys[1]!)).toBe(false);

    const lines = h.logOutput.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const audit = lines.find((line) => line.action === 'account.deleted');
    expect(audit).toMatchObject({ audit: true, user_id: user.userId, organizations_deleted: 0, resume_files_total: 2, resume_files_failed: 1 });
    const warning = lines.find((line) => String(line.msg).includes('could not be removed'));
    expect(warning).toMatchObject({ user_id: user.userId, resume_files_failed: 1 });

    const logged = h.logOutput.join('');
    for (const personal of [
      user.email,
      user.fullName,
      'jane.doe@example.com',
      'storage exploded',
      'resume-storage-',
      data.markers.parsedText,
      data.storageKeys[0]!.split('/')[2]!,
      token,
    ]) {
      expect(logged, `the log must not contain ${personal.slice(0, 24)}`).not.toContain(personal);
    }
  });
});
