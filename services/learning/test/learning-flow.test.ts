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
import { loadLearningServiceEnv } from '../src/env.js';
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

describe.skipIf(!testDatabaseUrl)('learning-service', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let broker: MemoryBroker;
  let subscriptions: Subscription[];
  let adminToken: string;
  let memberToken: string;
  const userId = randomUUID();
  const adminUserId = randomUUID();
  const companyName = `Learning Test Co ${randomUUID().slice(0, 8)}`;
  let companyId: string;
  const modelVersion = `test-model-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await stubJwks();
    const env = loadLearningServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4009', SUPABASE_URL });
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
    for (const u of [
      { id: userId, email: `learning-flow-${userId}@example.com`, fullName: 'Learning Flow User' },
      { id: adminUserId, email: `learning-flow-admin-${adminUserId}@example.com`, fullName: 'Admin' },
    ]) {
      await dbHandle.sql`
        insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values (${u.id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${u.email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: u.fullName })}::jsonb, now(), now())
      `;
    }
    const [company] = await dbHandle.db
      .insert(schema.companies)
      .values({ name: companyName, normalizedName: companyName.toLowerCase() })
      .returning();
    companyId = company!.companyId;

    const [appliedJob] = await dbHandle.db
      .insert(schema.jobs)
      .values({ companyId, title: 'Applied Job', source: 'manual', jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), isActive: true })
      .returning();
    const [skippedJob] = await dbHandle.db
      .insert(schema.jobs)
      .values({ companyId, title: 'Skipped Job', source: 'manual', jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), isActive: true })
      .returning();

    await dbHandle.db.insert(schema.jobScores).values([
      { jobId: appliedJob!.jobId, userId, score: 0.9, modelVersion },
      { jobId: skippedJob!.jobId, userId, score: 0.2, modelVersion },
    ]);
    await dbHandle.db
      .insert(schema.applications)
      .values({ userId, jobId: appliedJob!.jobId, organizationId: null, mode: 'manual', status: 'draft', idempotencyKey: randomUUID() });

    adminToken = await signTestToken({ sub: adminUserId, sid: randomUUID(), org: null, role: 'admin', email: 'admin@example.com' });
    memberToken = await signTestToken({ sub: userId, sid: randomUUID(), org: null, role: 'member', email: 'member@example.com' });
  });

  afterAll(async () => {
    await Promise.all(subscriptions.map((subscription) => subscription.stop()));
    await dbHandle.db.delete(schema.applications).where(eq(schema.applications.userId, userId));
    await dbHandle.db.delete(schema.jobScores).where(eq(schema.jobScores.userId, userId));
    await dbHandle.db.delete(schema.jobs).where(eq(schema.jobs.companyId, companyId));
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.companyId, companyId));
    // Cascades to public.users via the auth.users FK.
    await dbHandle.sql`delete from auth.users where id in (${userId}, ${adminUserId})`;
    await app.close();
    await broker.close();
    await dbHandle.close();
  });

  it('rejects a non-admin caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/learning/metrics', headers: { authorization: `Bearer ${memberToken}` } });
    expect(res.statusCode).toBe(403);
  });

  it('computes positive lift for a model whose higher scores got applied to', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/learning/metrics', headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    const model = res.json().models.find((m: { model_version: string }) => m.model_version === modelVersion);
    expect(model).toBeDefined();
    expect(model.applied_samples).toBe(1);
    expect(model.not_applied_samples).toBe(1);
    expect(model.lift).toBeCloseTo(0.7);
  });

  it('publishes learning.updated when an application.created event fires', async () => {
    await broker.publish(
      createEvent(
        'application.created',
        { application_id: randomUUID(), user_id: userId, job_id: randomUUID(), mode: 'manual' },
        newTraceContext({ user_id: userId }),
      ),
    );
    const updates = broker.publishedOf('learning.updated');
    expect(updates.some((e) => e.payload.model_version === modelVersion && e.payload.metric === 'score_lift')).toBe(true);
  });
});
