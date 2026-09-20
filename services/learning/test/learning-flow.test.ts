import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBroker, createEvent, type MemoryBroker, type Subscription } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadLearningServiceEnv } from '../src/env.js';
import { registerConsumers } from '../src/worker.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;
const JWT_SECRET = 'x'.repeat(32);

async function signTestToken(claims: { sub: string; sid: string; org: string | null; role: string | null; email: string }) {
  return new SignJWT({ sid: claims.sid, org: claims.org, role: claims.role, email: claims.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer('atlas')
    .setAudience('atlas-clients')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(new TextEncoder().encode(JWT_SECRET));
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
    const env = loadLearningServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4009', JWT_SECRET });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    broker = createBroker({ driver: 'memory', logger: createSilentLogger() }) as MemoryBroker;
    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      broker,
      tokenVerifier: { secret: new TextEncoder().encode(JWT_SECRET), issuer: 'atlas', audience: 'atlas-clients' },
    });
    await app.ready();
    subscriptions = await registerConsumers({ db: dbHandle.db, broker, logger: createSilentLogger() });

    await dbHandle.db.insert(schema.users).values([
      { userId, email: `learning-flow-${userId}@example.com`, fullName: 'Learning Flow User', authProvider: 'password' },
      { userId: adminUserId, email: `learning-flow-admin-${adminUserId}@example.com`, fullName: 'Admin', authProvider: 'password' },
    ]);
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
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, userId));
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, adminUserId));
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
