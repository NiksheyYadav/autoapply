import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createBroker, createEvent, type MemoryBroker, type Subscription } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadReferralsServiceEnv } from '../src/env.js';
import { registerConsumers } from '../src/worker.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const SUPABASE_URL = 'https://test-project.supabase.co';

let signTestToken: (claims: { sub: string; sid: string; org: string | null; role: string | null; email: string }) => Promise<string>;

// createRemoteJWKSet fetches over HTTP — stub it to serve a locally
// generated key instead of hitting a real Supabase project.
async function stubJwks(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );

  signTestToken = async (claims) =>
    new SignJWT({ session_id: claims.sid, email: claims.email, app_metadata: { org_id: claims.org, role: claims.role } })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(claims.sub)
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(privateKey);
}

describe.skipIf(!testDatabaseUrl)('referrals-service HTTP flow', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let broker: MemoryBroker;
  let subscriptions: Subscription[];
  let token: string;
  const userId = randomUUID();
  const email = `referrals-flow-${userId}@example.com`;
  const companyName = `Referrals Test Co ${randomUUID().slice(0, 8)}`;
  let companyId: string;
  let jobId: string;
  let applicationId: string;

  beforeAll(async () => {
    await stubJwks();
    const env = loadReferralsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4006', SUPABASE_URL });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    broker = createBroker({ driver: 'memory', logger: createSilentLogger() }) as MemoryBroker;
    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      broker,
      tokenVerifier: createTokenVerifierConfig(env),
    });
    await app.ready();
    subscriptions = await registerConsumers({ db: dbHandle.db, broker, logger: createSilentLogger() });

    // public.users.user_id FKs to auth.users.id (see packages/db/supabase/auth-hooks.sql);
    // inserting into auth.users fires handle_new_user, which creates the matching
    // public.users row itself.
    await dbHandle.sql`
      insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: 'Referrals Flow Test User' })}::jsonb, now(), now())
    `;
    const [company] = await dbHandle.db
      .insert(schema.companies)
      .values({ name: companyName, normalizedName: companyName.toLowerCase() })
      .returning();
    companyId = company!.companyId;
    const [job] = await dbHandle.db
      .insert(schema.jobs)
      .values({
        companyId,
        title: 'Backend Engineer',
        source: 'manual',
        jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        isActive: true,
      })
      .returning();
    jobId = job!.jobId;
    const [application] = await dbHandle.db
      .insert(schema.applications)
      .values({ userId, jobId, organizationId: null, mode: 'manual', status: 'draft', idempotencyKey: randomUUID() })
      .returning();
    applicationId = application!.applicationId;

    token = await signTestToken({ sub: userId, sid: randomUUID(), org: null, role: null, email });
  });

  afterAll(async () => {
    await Promise.all(subscriptions.map((subscription) => subscription.stop()));
    await dbHandle.db.delete(schema.applications).where(eq(schema.applications.userId, userId));
    await dbHandle.db.delete(schema.contacts).where(eq(schema.contacts.companyId, companyId));
    await dbHandle.db.delete(schema.jobs).where(eq(schema.jobs.companyId, companyId));
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.companyId, companyId));
    // Cascades to public.users via the auth.users FK.
    await dbHandle.sql`delete from auth.users where id = ${userId}`;
    await app.close();
    await broker.close();
    await dbHandle.close();
  });

  it('creates a contact, scoring its relevance from the title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: { authorization: `Bearer ${token}` },
      payload: { company_id: companyId, full_name: 'Grace Hopper', title: 'Technical Recruiter', email: `recruiter-${randomUUID()}@example.com` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().contact.relevance_score).toBe(0.9);
  });

  it('re-adding the same company+email is idempotent', async () => {
    const email2 = `dup-${randomUUID()}@example.com`;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: { authorization: `Bearer ${token}` },
      payload: { company_id: companyId, title: 'Engineering Manager', email: email2 },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: { authorization: `Bearer ${token}` },
      payload: { company_id: companyId, title: 'Engineering Manager', email: email2 },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().contact.contact_id).toBe(first.json().contact.contact_id);
  });

  it('lists a company\'s contacts ordered by relevance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/companies/${companyId}/contacts`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const scores = res.json().items.map((c: { relevance_score: number }) => c.relevance_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('surfaces the company\'s contacts as referral candidates for the applicant', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/referrals', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].company.company_id).toBe(companyId);
    expect(items[0].application_id).toBe(applicationId);
  });

  it('publishes referral.detected when an application.created event fires', async () => {
    await broker.publish(
      createEvent(
        'application.created',
        { application_id: applicationId, user_id: userId, job_id: jobId, mode: 'manual' },
        newTraceContext({ user_id: userId }),
      ),
    );
    const detected = broker.publishedOf('referral.detected');
    expect(detected.length).toBeGreaterThan(0);
    expect(detected[0]!.payload.company_id).toBe(companyId);
  });
});
