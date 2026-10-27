import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import postgres from 'postgres';
import { vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import type { ApplicationStatus, MemberRole, OrganizationType } from '@atlas/types';
import { createSilentLogger, type Logger } from '@atlas/utils';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadAdminServiceEnv } from '../src/env.js';

/** DB-backed suites self-skip when this is unset (see .env.example). */
export const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
export const SUPABASE_URL = 'https://test-project.supabase.co';

export const ADMIN_BASE = '/v1/admin/organizations';

export interface SeededUser {
  userId: string;
  email: string;
  fullName: string;
}

export interface Harness {
  app: FastifyInstance;
  handle: DatabaseHandle;
  /** Signs a token for `userId`. `org` / `role` are the claims the real auth hook would stamp. */
  token: (
    userId: string,
    claims?: { org?: string | null; role?: MemberRole | null },
  ) => Promise<string>;
  authHeaders: (userId: string, extra?: Record<string, string>) => Promise<Record<string, string>>;
  seedOrganization: (type?: OrganizationType) => Promise<string>;
  seedUser: (options?: {
    email?: string;
    fullName?: string;
    deleted?: boolean;
  }) => Promise<SeededUser>;
  addMember: (organizationId: string, userId: string, role: MemberRole) => Promise<void>;
  addStudent: (
    organizationId: string,
    userId: string,
    options?: { program?: string | null; graduationYear?: number | null; createdAt?: string },
  ) => Promise<string>;
  seedResume: (
    userId: string,
    options?: {
      atsScore?: number | null;
      status?: 'pending' | 'parsed' | 'failed';
      createdAt?: string;
      parsedText?: string;
    },
  ) => Promise<string>;
  seedApplication: (
    userId: string,
    options: { status: ApplicationStatus; organizationId: string | null; createdAt?: string },
  ) => Promise<string>;
  /** Registers rows the harness did not create but must clean up. */
  trackOrganization: (organizationId: string) => void;
  close: () => Promise<void>;
}

/**
 * Builds the app against the test database with a locally generated signing key
 * (the JWKS fetch is stubbed), and tracks every row it seeds so `close()` leaves
 * the shared database as it found it. Other agents use the same database
 * concurrently, so everything is keyed by fresh UUIDs.
 */
export async function createHarness(
  overrides: Partial<AppDeps> = {},
  logger: Logger = createSilentLogger(),
  envOverrides: Record<string, string> = {},
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

  // The suites fire hundreds of requests from one address; rate limiting has its own test.
  const env = loadAdminServiceEnv({
    DATABASE_URL: testDatabaseUrl,
    PORT: '4011',
    SUPABASE_URL,
    RATE_LIMIT_MAX: '100000',
    ...envOverrides,
  });
  const handle = createDatabase({ url: env.DATABASE_URL, maxConnections: 5 });
  const app = buildApp({
    db: handle.db,
    sql: handle.sql,
    env,
    logger,
    tokenVerifier: createTokenVerifierConfig(env),
    ...overrides,
    limits: { importRatePerMinute: 100_000, exportRatePerMinute: 100_000, ...overrides.limits },
  });
  await app.ready();

  const userIds: string[] = [];
  const organizationIds: string[] = [];
  const companyIds: string[] = [];
  const emails = new Map<string, string>();

  const token: Harness['token'] = async (userId, claims = {}) =>
    new SignJWT({
      session_id: randomUUID(),
      email: emails.get(userId) ?? `${userId}@example.test`,
      app_metadata: { org_id: claims.org ?? null, role: claims.role ?? null },
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(userId)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(privateKey);

  let seededCompanyId: string | undefined;
  const companyId = async (): Promise<string> => {
    if (seededCompanyId) return seededCompanyId;
    const name = `Admin Test Co ${randomUUID().slice(0, 8)}`;
    const [company] = await handle.db
      .insert(schema.companies)
      .values({ name, normalizedName: name.toLowerCase() })
      .returning();
    seededCompanyId = company!.companyId;
    companyIds.push(seededCompanyId);
    return seededCompanyId;
  };

  return {
    app,
    handle,
    token,
    authHeaders: async (userId, extra = {}) => ({
      authorization: `Bearer ${await token(userId)}`,
      ...extra,
    }),

    seedOrganization: async (type = 'university') => {
      const [org] = await handle.db
        .insert(schema.organizations)
        .values({ name: `Admin Test Org ${randomUUID().slice(0, 8)}`, type })
        .returning();
      organizationIds.push(org!.organizationId);
      return org!.organizationId;
    },

    seedUser: async (options = {}) => {
      const userId = randomUUID();
      const email = options.email ?? `admin-svc-${userId}@example.test`;
      const fullName = options.fullName ?? `Student ${userId.slice(0, 8)}`;
      // public.users.user_id FKs to auth.users.id; the insert fires handle_new_user, which creates the public row.
      await handle.sql`
        insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: fullName })}::jsonb, now(), now())
      `;
      if (options.deleted) {
        await handle.sql`update public.users set deleted_at = now() where user_id = ${userId}`;
      }
      userIds.push(userId);
      emails.set(userId, email);
      return { userId, email, fullName };
    },

    addMember: async (organizationId, userId, role) => {
      await handle.db.insert(schema.organizationMembers).values({ organizationId, userId, role });
    },

    addStudent: async (organizationId, userId, options = {}) => {
      const [student] = await handle.db
        .insert(schema.students)
        .values({
          organizationId,
          userId,
          department: options.program ?? null,
          graduationYear: options.graduationYear ?? null,
          ...(options.createdAt ? { createdAt: options.createdAt } : {}),
        })
        .returning();
      return student!.studentId;
    },

    seedResume: async (userId, options = {}) => {
      const [resume] = await handle.db
        .insert(schema.resumes)
        .values({
          userId,
          storageUrl: `resumes/${userId}/${randomUUID()}`,
          originalFilename: 'resume.pdf',
          contentType: 'application/pdf',
          byteSize: 1234,
          contentHash: randomUUID().replace(/-/g, ''),
          status: options.status ?? 'parsed',
          atsScore: options.atsScore === undefined ? 70 : options.atsScore,
          parsedText:
            options.parsedText ?? 'CONFIDENTIAL-RESUME-TEXT jane@private.example +1 555 0100',
          parsedProfile: { skills: ['CONFIDENTIAL-SKILL'] } as never,
          ...(options.createdAt ? { createdAt: options.createdAt } : {}),
        })
        .returning();
      return resume!.resumeId;
    },

    seedApplication: async (userId, options) => {
      const companyRowId = await companyId();
      const [job] = await handle.db
        .insert(schema.jobs)
        .values({
          companyId: companyRowId,
          title: 'CONFIDENTIAL-JOB-TITLE',
          source: 'manual',
          jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        })
        .returning();
      const [application] = await handle.db
        .insert(schema.applications)
        .values({
          userId,
          jobId: job!.jobId,
          organizationId: options.organizationId,
          status: options.status,
          idempotencyKey: `seed-${randomUUID()}`,
          coverLetter: 'CONFIDENTIAL-COVER-LETTER',
          ...(options.createdAt
            ? { createdAt: options.createdAt, lastEventAt: options.createdAt }
            : {}),
        })
        .returning();
      return application!.applicationId;
    },

    trackOrganization: (organizationId) => {
      organizationIds.push(organizationId);
    },

    close: async () => {
      try {
        if (organizationIds.length > 0) {
          // audit_logs.organization_id is ON DELETE SET NULL, so delete the rows explicitly or they linger.
          await handle.db
            .delete(schema.auditLogs)
            .where(inArray(schema.auditLogs.organizationId, organizationIds));
        }
        if (userIds.length > 0) {
          // Cascades to public.users and from there to students, resumes, applications, idempotency_keys, memberships.
          await handle.sql`delete from auth.users where id in ${handle.sql(userIds)}`;
        }
        if (companyIds.length > 0) {
          await handle.db
            .delete(schema.companies)
            .where(inArray(schema.companies.companyId, companyIds));
        }
        if (organizationIds.length > 0) {
          await handle.db
            .delete(schema.organizations)
            .where(inArray(schema.organizations.organizationId, organizationIds));
        }
      } finally {
        vi.unstubAllGlobals();
        await app.close();
        await handle.close();
      }
    },
  };
}

export interface CountingDatabase {
  db: DatabaseHandle['db'];
  sql: DatabaseHandle['sql'];
  /** Statements the driver has executed since the last `reset()` (BEGIN/COMMIT included). */
  count: () => number;
  reset: () => void;
  close: () => Promise<void>;
}

/** A database handle that counts every statement, for asserting "no N+1". */
export function createCountingDatabase(): CountingDatabase {
  if (!testDatabaseUrl) throw new Error('ATLAS_TEST_DATABASE_URL is required');
  let statements = 0;
  const sql = postgres(testDatabaseUrl, {
    max: 5,
    prepare: false,
    onnotice: () => {},
    debug: () => {
      statements += 1;
    },
  });
  return {
    db: drizzle(sql, { schema }),
    sql,
    count: () => statements,
    reset: () => {
      statements = 0;
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** A JSON POST to the import endpoint. */
export function importJson(
  harness: Harness,
  organizationId: string,
  headers: Record<string, string>,
  rows: unknown,
  key: string = randomUUID(),
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url: `${ADMIN_BASE}/${organizationId}/students/import`,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': key },
    payload: JSON.stringify(Array.isArray(rows) ? { rows } : rows),
  });
}

/** A text/csv POST to the import endpoint. */
export function importCsv(
  harness: Harness,
  organizationId: string,
  headers: Record<string, string>,
  csv: string,
  key: string = randomUUID(),
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url: `${ADMIN_BASE}/${organizationId}/students/import`,
    headers: { ...headers, 'content-type': 'text/csv; charset=utf-8', 'idempotency-key': key },
    payload: csv,
  });
}
