import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createBroker, type MemoryBroker } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadOutreachServiceEnv } from '../src/env.js';
import { createTransport } from '../src/lib/transport.js';

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

describe.skipIf(!testDatabaseUrl)('outreach-service HTTP flow', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let broker: MemoryBroker;
  let token: string;
  let otherToken: string;
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const email = `outreach-flow-${userId}@example.com`;
  const otherEmail = `outreach-flow-${otherUserId}@example.com`;
  const companyName = `Outreach Test Co ${randomUUID().slice(0, 8)}`;
  let companyId: string;
  let applicationId: string;
  let contactId: string;

  beforeAll(async () => {
    await stubJwks();
    const env = loadOutreachServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4007', SUPABASE_URL });
    dbHandle = createDatabase({ url: env.DATABASE_URL });
    broker = createBroker({ driver: 'memory', logger: createSilentLogger() }) as MemoryBroker;
    const transport = createTransport({ driver: 'local', logger: createSilentLogger() });
    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      broker,
      transport,
      tokenVerifier: createTokenVerifierConfig(env),
    });
    await app.ready();

    // public.users.user_id FKs to auth.users.id (see packages/db/supabase/auth-hooks.sql);
    // inserting into auth.users fires handle_new_user, which creates the matching
    // public.users row itself.
    for (const u of [
      { id: userId, email, fullName: 'Outreach Flow Test User' },
      { id: otherUserId, email: otherEmail, fullName: 'Someone Else' },
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
    const [application] = await dbHandle.db
      .insert(schema.applications)
      .values({ userId, jobId: job!.jobId, organizationId: null, mode: 'manual', status: 'draft', idempotencyKey: randomUUID() })
      .returning();
    applicationId = application!.applicationId;
    const [contact] = await dbHandle.db
      .insert(schema.contacts)
      .values({ companyId, fullName: 'Grace Hopper', title: 'Engineering Manager', relevanceScore: 0.85, source: 'manual' })
      .returning();
    contactId = contact!.contactId;

    token = await signTestToken({ sub: userId, sid: randomUUID(), org: null, role: null, email });
    otherToken = await signTestToken({ sub: otherUserId, sid: randomUUID(), org: null, role: null, email: otherEmail });
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.messages).where(eq(schema.messages.userId, userId));
    await dbHandle.db.delete(schema.applications).where(eq(schema.applications.userId, userId));
    await dbHandle.db.delete(schema.contacts).where(eq(schema.contacts.companyId, companyId));
    await dbHandle.db.delete(schema.jobs).where(eq(schema.jobs.companyId, companyId));
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.companyId, companyId));
    // Cascades to public.users via the auth.users FK.
    await dbHandle.sql`delete from auth.users where id in (${userId}, ${otherUserId})`;
    await app.close();
    await broker.close();
    await dbHandle.close();
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { application_id: applicationId, contact_id: null, channel: 'email' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('rejects a message anchored to neither an application nor a contact', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-none' },
      payload: { application_id: null, contact_id: null, channel: 'email' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  let messageId: string;

  it('auto-drafts a message from the application + contact context', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-draft-1' },
      payload: { application_id: applicationId, contact_id: contactId, channel: 'email' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.message.status).toBe('draft');
    expect(body.message.subject).toContain('Backend Engineer');
    expect(body.message.body).toContain('Grace Hopper');
    messageId = body.message.message_id;
  });

  it("404s when another user fetches someone else's message", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/messages/${messageId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects scheduling in the past', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/messages/${messageId}/schedule`,
      headers: { authorization: `Bearer ${token}` },
      payload: { scheduled_for: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('schedules the message for the future', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/messages/${messageId}/schedule`,
      headers: { authorization: `Bearer ${token}` },
      payload: { scheduled_for: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message.status).toBe('scheduled');
  });

  it('sends the message via the local transport and publishes outreach.sent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/messages/${messageId}/send`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message.status).toBe('sent');
    expect(broker.publishedOf('outreach.sent').some((e) => e.payload.message_id === messageId)).toBe(true);
  });

  it('rejects sending an already-sent message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/messages/${messageId}/send`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists the caller\'s own messages', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/messages', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((m: { message_id: string }) => m.message_id)).toContain(messageId);
  });
});
