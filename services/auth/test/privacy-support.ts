import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { inArray, or, sql as drizzleSql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createLocalDriver, type StorageDriver } from '@atlas/storage';
import type { OrganizationType, ParsedProfile } from '@atlas/types';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadAuthServiceEnv } from '../src/env.js';

/** DB-backed suites self-skip when this is unset (see .env.example). */
export const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
export const SUPABASE_URL = 'https://test-project.supabase.co';

export interface SeededUser {
  userId: string;
  email: string;
  fullName: string;
}

export interface Harness {
  app: FastifyInstance;
  handle: DatabaseHandle;
  /** The driver the app deletes resume files through. */
  storage: StorageDriver;
  /** Every line the app logged, as written. */
  logOutput: string[];
  token: (userId: string) => Promise<string>;
  authHeaders: (userId: string, extra?: Record<string, string>) => Promise<Record<string, string>>;
  seedUser: () => Promise<SeededUser>;
  seedOrganization: (type?: OrganizationType) => Promise<string>;
  /** A shared company with `count` jobs; shared listings are not anyone's data. */
  seedJobs: (count: number) => Promise<string[]>;
  close: () => Promise<void>;
}

/**
 * The app against the test database with a locally generated signing key (the JWKS fetch is
 * stubbed) and a local-disk storage driver in a temp directory. Everything seeded is tracked so
 * `close()` leaves the shared database as it found it; other suites use it concurrently, so every
 * row is keyed by fresh UUIDs.
 */
export async function createHarness(
  options: {
    overrides?: Partial<AppDeps>;
    envOverrides?: Record<string, string>;
    /** Wraps the local driver, e.g. to make some deletions fail. */
    wrapStorage?: (inner: StorageDriver) => StorageDriver;
  } = {},
): Promise<Harness> {
  if (!testDatabaseUrl) throw new Error('ATLAS_TEST_DATABASE_URL is required');

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  // createRemoteJWKSet fetches over HTTP: serve the local key instead of a real Supabase project.
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  const logOutput: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      logOutput.push(String(chunk));
      done();
    },
  });

  const env = loadAuthServiceEnv({
    DATABASE_URL: testDatabaseUrl,
    PORT: '4001',
    SUPABASE_URL,
    // The suites fire many requests from one address; rate limiting has its own suite.
    RATE_LIMIT_MAX: '100000',
    PRIVACY_EXPORT_RATE_LIMIT_MAX: '100000',
    PRIVACY_DELETE_RATE_LIMIT_MAX: '100000',
    ...options.envOverrides,
  });
  const handle = createDatabase({ url: env.DATABASE_URL, maxConnections: 5 });
  const storageRoot = await mkdtemp(join(tmpdir(), 'atlas-auth-privacy-'));
  const localStorage = createLocalDriver({ root: storageRoot });
  const storage = options.wrapStorage ? options.wrapStorage(localStorage) : localStorage;

  const app = buildApp({
    db: handle.db,
    sql: handle.sql,
    env,
    logger: pino({ level: 'info' }, sink),
    tokenVerifier: createTokenVerifierConfig(env),
    storage,
    ...options.overrides,
  });
  await app.ready();

  const userIds: string[] = [];
  const organizationIds: string[] = [];
  const companyIds: string[] = [];
  const emails = new Map<string, string>();

  const token: Harness['token'] = async (userId) =>
    new SignJWT({
      session_id: randomUUID(),
      email: emails.get(userId) ?? `${userId}@example.test`,
      app_metadata: { org_id: null, role: null },
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(userId)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(privateKey);

  return {
    app,
    handle,
    storage,
    logOutput,
    token,
    authHeaders: async (userId, extra = {}) => ({
      authorization: `Bearer ${await token(userId)}`,
      ...extra,
    }),

    seedUser: async () => {
      const userId = randomUUID();
      const email = `auth-privacy-${userId}@example.test`;
      const fullName = `Privacy Tester ${userId.slice(0, 8)}`;
      // public.users.user_id FKs to auth.users.id; the insert fires handle_new_user, which creates
      // the public row (and nothing else: it creates no organizations or memberships).
      await handle.sql`
        insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: fullName })}::jsonb, now(), now())
      `;
      userIds.push(userId);
      emails.set(userId, email);
      return { userId, email, fullName };
    },

    seedOrganization: async (type = 'university') => {
      const [org] = await handle.db
        .insert(schema.organizations)
        .values({ name: `Privacy Test Org ${randomUUID().slice(0, 8)}`, type })
        .returning();
      organizationIds.push(org!.organizationId);
      return org!.organizationId;
    },

    seedJobs: async (count) => {
      const name = `Privacy Test Co ${randomUUID().slice(0, 8)}`;
      const [company] = await handle.db
        .insert(schema.companies)
        .values({ name, normalizedName: name.toLowerCase() })
        .returning();
      companyIds.push(company!.companyId);
      const jobs = await handle.db
        .insert(schema.jobs)
        .values(
          Array.from({ length: count }, (_, index) => ({
            companyId: company!.companyId,
            title: `Engineer ${index}`,
            location: 'Remote',
            source: 'manual' as const,
            jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          })),
        )
        .returning();
      return jobs.map((job) => job.jobId);
    },

    close: async () => {
      // Tombstones outlive their (deleted) user by design, so they are cleaned up by id.
      if (userIds.length > 0) {
        await handle.db
          .delete(schema.auditLogs)
          .where(
            or(
              inArray(schema.auditLogs.resourceId, userIds),
              inArray(schema.auditLogs.actorUserId, userIds),
            ),
          );
        for (const userId of userIds) {
          await handle.db.delete(schema.eventOutbox).where(drizzleSql`${schema.eventOutbox.payload} ->> 'user_id' = ${userId}`);
          await handle.db.delete(schema.tasks).where(drizzleSql`${schema.tasks.payload} ->> 'user_id' = ${userId}`);
          await handle.db.delete(schema.analyticsEvents).where(drizzleSql`${schema.analyticsEvents.payload} ->> 'user_id' = ${userId}`);
        }
        // Cascades to public.users, and from there to everything that references it.
        await handle.sql`delete from auth.users where id in ${handle.sql(userIds)}`;
      }
      if (organizationIds.length > 0) {
        await handle.db.delete(schema.organizations).where(inArray(schema.organizations.organizationId, organizationIds));
      }
      if (companyIds.length > 0) {
        await handle.db.delete(schema.companies).where(inArray(schema.companies.companyId, companyIds));
      }
      await app.close();
      await handle.close();
      await rm(storageRoot, { recursive: true, force: true });
      vi.unstubAllGlobals();
    },
  };
}

// --- seeding one user's data in every table that can hold it -----------------------------------

export interface SeededData {
  resumeIds: string[];
  /** Storage keys of the resume files written to the harness storage. */
  storageKeys: string[];
  applicationIds: string[];
  messageIds: string[];
  /** Strings that appear only in this user's data; none of them may leak to anyone else. */
  markers: {
    parsedText: string;
    coverLetter: string;
    messageBody: string;
    eventNote: string;
    passwordHash: string;
    mfaSecret: string;
    secretRef: string;
  };
  contactId: string;
  eventIds: { outboxByColumn: string; outboxByPayload: string; analyticsByColumn: string; analyticsByPayload: string };
  taskId: string;
}

const PARSED_PROFILE = (fullName: string): ParsedProfile => ({
  full_name: fullName,
  headline: 'Backend engineer',
  summary: null,
  contact: { email: null, phone: null, location: null, links: [] },
  skills: [{ name: 'postgresql', raw: 'PostgreSQL', months_experience: 24 }],
  experience: [],
  education: [],
  certifications: [],
  keywords: ['postgresql'],
  total_months_experience: 24,
});

/**
 * Gives `user` data in every table that references a user, including the ones no foreign key
 * covers (event_outbox, tasks, and rows that name the user only inside a jsonb payload), so a
 * deletion that misses any of them is visible.
 */
export async function seedUserData(
  h: Harness,
  user: SeededUser,
  options: { label: string; jobIds: string[]; organizationId?: string; companyId?: string },
): Promise<SeededData> {
  const { db } = h.handle;
  const { userId } = user;
  const { label } = options;
  const markers = {
    parsedText: `PARSED-TEXT-${label}-${randomUUID()}`,
    coverLetter: `COVER-LETTER-${label}-${randomUUID()}`,
    messageBody: `MESSAGE-BODY-${label}-${randomUUID()}`,
    eventNote: `EVENT-NOTE-${label}-${randomUUID()}`,
    passwordHash: `PASSWORD-HASH-${label}-${randomUUID()}`,
    mfaSecret: `MFA-SECRET-${label}-${randomUUID()}`,
    secretRef: `SECRET-REF-${label}-${randomUUID()}`,
  };

  const resumeIds: string[] = [];
  const storageKeys: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const contentHash = randomUUID().replace(/-/g, '').padEnd(64, '0');
    const key = `resumes/${userId}/${contentHash}`;
    await h.storage.put(key, Buffer.from(`resume file ${label} ${index}`), { contentType: 'text/plain' });
    storageKeys.push(key);
    const [resume] = await db
      .insert(schema.resumes)
      .values({
        userId,
        storageUrl: key,
        originalFilename: `resume-${label}-${index}.pdf`,
        contentType: 'application/pdf',
        byteSize: 1234,
        contentHash,
        status: 'parsed',
        parsedText: `${markers.parsedText} #${index}`,
        parsedProfile: PARSED_PROFILE(user.fullName),
        atsScore: 80 - index,
        atsReport: { score: 80 - index },
        embedding: Array.from({ length: 1536 }, () => 0.25),
        parsedAt: new Date().toISOString(),
      })
      .returning();
    resumeIds.push(resume!.resumeId);
  }
  await h.handle.sql`
    update public.users
       set profile_id = ${resumeIds[0]!}, password_hash = ${markers.passwordHash}, mfa_secret = ${markers.mfaSecret}
     where user_id = ${userId}
  `;

  const applicationIds: string[] = [];
  for (const [index, jobId] of options.jobIds.slice(0, 2).entries()) {
    const [application] = await db
      .insert(schema.applications)
      .values({
        userId,
        jobId,
        resumeId: resumeIds[0]!,
        organizationId: options.organizationId ?? null,
        status: 'submitted',
        mode: 'manual',
        idempotencyKey: `idem-${label}-${index}-${randomUUID()}`,
        coverLetter: `${markers.coverLetter} #${index}`,
      })
      .returning();
    applicationIds.push(application!.applicationId);
    // Explicit times: rows written by one statement share a timestamp, and the trail is ordered by it.
    const draftedAt = Date.now() - 60_000;
    await db.insert(schema.applicationEvents).values([
      { applicationId: application!.applicationId, toStatus: 'draft', note: null, createdAt: new Date(draftedAt).toISOString() },
      {
        applicationId: application!.applicationId,
        fromStatus: 'draft',
        toStatus: 'submitted',
        note: `${markers.eventNote} #${index}`,
        createdAt: new Date(draftedAt + 1_000).toISOString(),
      },
    ]);
    await db.insert(schema.jobScores).values({
      jobId,
      userId,
      score: 0.9 - index / 10,
      reasons: [`reason ${label}`],
      skillGaps: [],
      modelVersion: 'test-model',
    });
  }

  const [contact] = await db
    .insert(schema.contacts)
    .values({
      companyId: options.companyId ?? (await companyIdOf(h, options.jobIds[0]!)),
      fullName: `Shared Contact ${randomUUID().slice(0, 8)}`,
      email: `contact-${randomUUID()}@example.test`,
    })
    .returning();
  const messageIds: string[] = [];
  for (const [index, contactId] of [contact!.contactId, null].entries()) {
    const [message] = await db
      .insert(schema.messages)
      .values({
        userId,
        applicationId: applicationIds[0]!,
        contactId,
        channel: 'email',
        status: 'draft',
        subject: `Subject ${label} ${index}`,
        body: `${markers.messageBody} #${index}`,
        idempotencyKey: `msg-${label}-${index}-${randomUUID()}`,
      })
      .returning();
    messageIds.push(message!.messageId);
  }

  if (options.organizationId) {
    await db.insert(schema.students).values({
      organizationId: options.organizationId,
      userId,
      department: 'Computer Science',
      graduationYear: 2027,
    });
    // An entry from the user acting inside an organization: kept by design, anonymized by its foreign key.
    await db.insert(schema.auditLogs).values({
      organizationId: options.organizationId,
      actorUserId: userId,
      action: 'admin.students.export',
      resourceType: 'student_roster',
      resourceId: options.organizationId,
      traceId: randomUUID(),
      metadata: { rows: 3 },
    });
  }
  // The user's own account-level audit entry (what an export leaves behind).
  await db.insert(schema.auditLogs).values({
    actorUserId: userId,
    action: 'account.export',
    resourceType: 'user',
    resourceId: userId,
    traceId: randomUUID(),
    metadata: {},
  });

  const analyticsByColumn = randomUUID();
  const analyticsByPayload = randomUUID();
  await db.insert(schema.analyticsEvents).values([
    {
      eventId: analyticsByColumn,
      userId,
      organizationId: options.organizationId ?? null,
      eventType: 'application.created',
      payload: { application_id: applicationIds[0], user_id: userId },
    },
    // Attributed to nobody in the column, but the payload names the user.
    {
      eventId: analyticsByPayload,
      userId: null,
      eventType: 'referral.detected',
      payload: { contact_id: contact!.contactId, user_id: userId, relevance_score: 0.5 },
    },
  ]);

  const outboxByColumn = randomUUID();
  const outboxByPayload = randomUUID();
  await db.insert(schema.eventOutbox).values([
    {
      eventId: outboxByColumn,
      eventType: 'resume.parsed',
      occurredAt: new Date().toISOString(),
      traceId: randomUUID(),
      correlationId: randomUUID(),
      userId,
      payload: { resume_id: resumeIds[0], user_id: userId },
    },
    {
      eventId: outboxByPayload,
      eventType: 'job.scored',
      occurredAt: new Date().toISOString(),
      traceId: randomUUID(),
      correlationId: randomUUID(),
      userId: null,
      payload: { job_id: options.jobIds[0], user_id: userId, score: 0.9 },
    },
  ]);
  await db.insert(schema.eventDeliveries).values([
    { eventId: outboxByColumn, consumer: 'privacy-test-consumer' },
    { eventId: outboxByPayload, consumer: 'privacy-test-consumer' },
  ]);

  const [task] = await db
    .insert(schema.tasks)
    .values({ taskType: 'privacy.test', payload: { user_id: userId } })
    .returning();

  await db.insert(schema.idempotencyKeys).values({
    key: `idem-key-${randomUUID()}`,
    scope: `privacy-test:${userId}`,
    userId,
    requestHash: 'a'.repeat(64),
    responseStatus: 201,
    responseBody: { note: `${markers.eventNote} cached` },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  await db.insert(schema.connectorAccounts).values({
    userId,
    provider: 'greenhouse',
    externalAccountId: `external-${randomUUID()}`,
    secretRef: markers.secretRef,
    scopes: ['read'],
    status: 'revoked',
  });

  return {
    resumeIds,
    storageKeys,
    applicationIds,
    messageIds,
    markers,
    contactId: contact!.contactId,
    eventIds: { outboxByColumn, outboxByPayload, analyticsByColumn, analyticsByPayload },
    taskId: task!.taskId,
  };
}

async function companyIdOf(h: Harness, jobId: string): Promise<string> {
  const [row] = await h.handle.sql<Array<{ company_id: string }>>`select company_id from public.jobs where job_id = ${jobId}`;
  return row!.company_id;
}

// --- the completeness scan ----------------------------------------------------------------------

export interface UserColumn {
  table: string;
  column: string;
}

/**
 * Every uuid column in `public` whose name says it points at a user. Read from information_schema
 * rather than listed, so a table added later shows up here.
 */
export async function userLikeColumns(sql: postgres.Sql): Promise<UserColumn[]> {
  const rows = await sql<Array<{ table_name: string; column_name: string }>>`
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public'
       and c.data_type = 'uuid'
       and c.column_name ilike '%user%'
     order by c.table_name, c.column_name
  `;
  return rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

async function publicTables(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<Array<{ table_name: string }>>`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name
  `;
  return rows.map((row) => row.table_name);
}

/** Rows that point at the user through a user-like column, per `table.column`. */
export async function referencesByColumn(sql: postgres.Sql, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table, column } of await userLikeColumns(sql)) {
    const [row] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from ${sql(table)} where ${sql(column)} = ${userId}
    `;
    out[`${table}.${column}`] = row!.n;
  }
  return out;
}

/**
 * Rows, in any table, whose text form contains any of `needles` anywhere (a foreign key column, a
 * jsonb payload, free text). This catches what a column-by-column check cannot: an id embedded in a
 * payload, a name pasted into a note. The `account.deleted` tombstones in audit_logs are the one
 * thing allowed to mention a user id after deletion, so they are left out here and asserted on
 * their own.
 */
export async function rowsMentioning(sql: postgres.Sql, needles: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of await publicTables(sql)) {
    const exclusion = table === 'audit_logs' ? sql`and r.action <> 'account.deleted'` : sql``;
    let total = 0;
    for (const needle of needles) {
      const pattern = `%${needle}%`;
      const [row] = await sql<Array<{ n: number }>>`
        select count(*)::int as n from ${sql(table)} as r where r::text ilike ${pattern} ${exclusion}
      `;
      total += row!.n;
    }
    if (total > 0) out[table] = total;
  }
  return out;
}
