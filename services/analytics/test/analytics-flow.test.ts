import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createBroker, createEvent, type EventBroker, type Subscription } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger, newTraceContext } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadAnalyticsServiceEnv } from '../src/env.js';
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
    await stubJwks();
    const env = loadAnalyticsServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4010', SUPABASE_URL });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    broker = createBroker({ driver: 'memory', logger: createSilentLogger() });
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

    await dbHandle.db.insert(schema.organizations).values({ organizationId, name: `Analytics Test Org ${organizationId.slice(0, 8)}`, type: 'enterprise' });
    // public.users.user_id FKs to auth.users.id (see packages/db/supabase/auth-hooks.sql);
    // inserting into auth.users fires handle_new_user, which creates the matching
    // public.users row itself.
    for (const u of [
      { id: userId, email: `analytics-flow-${userId}@example.com`, fullName: 'User' },
      { id: adminUserId, email: `analytics-flow-admin-${adminUserId}@example.com`, fullName: 'Admin' },
      { id: noOrgAdminUserId, email: `analytics-flow-noorg-${noOrgAdminUserId}@example.com`, fullName: 'No Org Admin' },
    ]) {
      await dbHandle.sql`
        insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values (${u.id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${u.email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: u.fullName })}::jsonb, now(), now())
      `;
    }

    adminToken = await signTestToken({ sub: adminUserId, sid: randomUUID(), org: organizationId, role: 'admin', email: 'admin@example.com' });
    noOrgAdminToken = await signTestToken({ sub: noOrgAdminUserId, sid: randomUUID(), org: null, role: 'admin', email: 'noorg@example.com' });
    memberToken = await signTestToken({ sub: userId, sid: randomUUID(), org: organizationId, role: 'member', email: 'member@example.com' });
  });

  afterAll(async () => {
    await Promise.all(subscriptions.map((subscription) => subscription.stop()));
    await dbHandle.db.delete(schema.analyticsEvents).where(eq(schema.analyticsEvents.organizationId, organizationId));
    await dbHandle.db.delete(schema.processedEvents);
    // Cascades to public.users via the auth.users FK.
    await dbHandle.sql`delete from auth.users where id in (${userId}, ${adminUserId}, ${noOrgAdminUserId})`;
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
