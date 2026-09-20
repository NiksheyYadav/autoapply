import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBroker, createEvent, type EventBroker, type Subscription } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadAnalyticsServiceEnv } from '../src/env.js';
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

describe.skipIf(!testDatabaseUrl)('analytics-service', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let broker: EventBroker;
  let subscriptions: Subscription[];
  let adminToken: string;
  let noOrgAdminToken: string;
  let memberToken: string;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const adminUserId = randomUUID();
  const noOrgAdminUserId = randomUUID();

  beforeAll(async () => {
    const env = loadAnalyticsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4010', JWT_SECRET });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    broker = createBroker({ driver: 'memory', logger: createSilentLogger() });
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

    await dbHandle.db.insert(schema.organizations).values({ organizationId, name: `Analytics Test Org ${organizationId.slice(0, 8)}`, type: 'enterprise' });
    await dbHandle.db.insert(schema.users).values([
      { userId, email: `analytics-flow-${userId}@example.com`, fullName: 'User', authProvider: 'password' },
      { userId: adminUserId, email: `analytics-flow-admin-${adminUserId}@example.com`, fullName: 'Admin', authProvider: 'password' },
      { userId: noOrgAdminUserId, email: `analytics-flow-noorg-${noOrgAdminUserId}@example.com`, fullName: 'No Org Admin', authProvider: 'password' },
    ]);

    adminToken = await signTestToken({ sub: adminUserId, sid: randomUUID(), org: organizationId, role: 'admin', email: 'admin@example.com' });
    noOrgAdminToken = await signTestToken({ sub: noOrgAdminUserId, sid: randomUUID(), org: null, role: 'admin', email: 'noorg@example.com' });
    memberToken = await signTestToken({ sub: userId, sid: randomUUID(), org: organizationId, role: 'member', email: 'member@example.com' });
  });

  afterAll(async () => {
    await Promise.all(subscriptions.map((subscription) => subscription.stop()));
    await dbHandle.db.delete(schema.analyticsEvents).where(eq(schema.analyticsEvents.organizationId, organizationId));
    await dbHandle.db.delete(schema.processedEvents);
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, userId));
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, adminUserId));
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, noOrgAdminUserId));
    await dbHandle.db.delete(schema.organizations).where(eq(schema.organizations.organizationId, organizationId));
    await app.close();
    await dbHandle.close();
  });

  it('records events published on the bus, deduped by event id', async () => {
    const envelope = createEvent(
      'application.created',
      { application_id: randomUUID(), user_id: userId, job_id: randomUUID(), mode: 'manual' },
      newTraceContext({ organization_id: organizationId, user_id: userId }),
    );
    await broker.publish(envelope);
    await broker.publish(envelope); // exact same event_id — must not double-count

    const rows = await dbHandle.db
      .select()
      .from(schema.analyticsEvents)
      .where(and(eq(schema.analyticsEvents.organizationId, organizationId), eq(schema.analyticsEvents.eventType, 'application.created')));
    expect(rows).toHaveLength(1);
  });

  it('rejects a non-admin caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/analytics/summary', headers: { authorization: `Bearer ${memberToken}` } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an admin with no organization', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/analytics/summary', headers: { authorization: `Bearer ${noOrgAdminToken}` } });
    expect(res.statusCode).toBe(400);
  });

  it("summarizes the org's event counts", async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/analytics/summary', headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.organization_id).toBe(organizationId);
    const applicationCreated = body.events.find((e: { event_type: string }) => e.event_type === 'application.created');
    expect(applicationCreated.count).toBe(1);
  });
});
