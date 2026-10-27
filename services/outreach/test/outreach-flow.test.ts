import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createBroker, derivedEventId, type MemoryBroker } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import type { MessageStatus } from '@atlas/types';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadOutreachServiceEnv } from '../src/env.js';
import { createTransport } from '../src/lib/transport.js';
import { stubJwksAndCreateSigner, SUPABASE_URL } from './support.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('outreach-service HTTP flow', () => {
  // Two deployments over one database: the production default (Atlas delivers nothing) and the
  // dev/test one where the log-only local transport "sends".
  let app: FastifyInstance;
  let broker: MemoryBroker;
  let offApp: FastifyInstance;
  let offBroker: MemoryBroker;
  let dbHandle: DatabaseHandle;
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
  const apps: FastifyInstance[] = [];

  function make(envOverrides: Record<string, string>, theBroker: MemoryBroker): FastifyInstance {
    const env = loadOutreachServiceEnv({
      DATABASE_URL: testDatabaseUrl,
      PORT: '4007',
      SUPABASE_URL,
      LOG_LEVEL: 'fatal',
      ...envOverrides,
    });
    const built = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      broker: theBroker,
      transport: createTransport({ driver: 'local', logger: createSilentLogger() }),
      tokenVerifier: createTokenVerifierConfig(env),
    });
    apps.push(built);
    return built;
  }

  beforeAll(async () => {
    const sign = await stubJwksAndCreateSigner();
    dbHandle = createDatabase({ url: testDatabaseUrl! });
    broker = createBroker({ driver: 'memory', logger: createSilentLogger() }) as MemoryBroker;
    offBroker = createBroker({ driver: 'memory', logger: createSilentLogger() }) as MemoryBroker;
    app = make({ OUTREACH_DELIVERY_ENABLED: 'true' }, broker);
    offApp = make({}, offBroker);
    await app.ready();
    await offApp.ready();

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

    token = await sign({ sub: userId, sid: randomUUID(), org: null, role: null, email });
    otherToken = await sign({ sub: otherUserId, sid: randomUUID(), org: null, role: null, email: otherEmail });
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.messages).where(eq(schema.messages.userId, userId));
    await dbHandle.db.delete(schema.applications).where(eq(schema.applications.userId, userId));
    await dbHandle.db.delete(schema.contacts).where(eq(schema.contacts.companyId, companyId));
    await dbHandle.db.delete(schema.jobs).where(eq(schema.jobs.companyId, companyId));
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.companyId, companyId));
    // Cascades to public.users via the auth.users FK.
    await dbHandle.sql`delete from auth.users where id in (${userId}, ${otherUserId})`;
    for (const built of apps) await built.close();
    await broker.close();
    await offBroker.close();
    await dbHandle.close();
    vi.unstubAllGlobals();
  });

  const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

  /** A fresh draft owned by `userId`, created through the API like a client would. */
  async function newDraft(): Promise<string> {
    const res = await offApp.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { ...bearer(token), 'idempotency-key': `idem-${randomUUID()}` },
      payload: { application_id: applicationId, contact_id: contactId, channel: 'email' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().message.message_id;
  }

  async function row(messageId: string) {
    const [found] = await dbHandle.db.select().from(schema.messages).where(eq(schema.messages.messageId, messageId));
    return found!;
  }

  async function forceStatus(messageId: string, status: MessageStatus, scheduledFor: string | null = null) {
    await dbHandle.db.update(schema.messages).set({ status, scheduledFor }).where(eq(schema.messages.messageId, messageId));
  }

  const markSent = (target: FastifyInstance, messageId: string, as: string, payload?: unknown) =>
    target.inject({ method: 'POST', url: `/v1/messages/${messageId}/mark-sent`, headers: bearer(as), ...(payload === undefined ? {} : { payload }) });

  const sentEventsFor = (theBroker: MemoryBroker, messageId: string) =>
    theBroker.publishedOf('outreach.sent').filter((e) => e.payload.message_id === messageId);

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

  describe('delivery disabled (the production default)', () => {
    it('refuses to send a draft, leaves the row untouched and publishes nothing', async () => {
      const id = await newDraft();
      const before = await row(id);
      const eventsBefore = offBroker.published.length;

      const res = await offApp.inject({ method: 'POST', url: `/v1/messages/${id}/send`, headers: bearer(token) });

      expect(res.statusCode).toBe(503);
      expect(res.json().error.details.reason).toBe('delivery_disabled');
      expect(await row(id)).toEqual(before);
      expect(before.status).toBe('draft');
      expect(before.sentAt).toBeNull();
      expect(offBroker.published).toHaveLength(eventsBefore);
    });

    it('refuses to schedule a draft and leaves the row untouched', async () => {
      const id = await newDraft();
      const before = await row(id);
      const eventsBefore = offBroker.published.length;

      const res = await offApp.inject({
        method: 'POST',
        url: `/v1/messages/${id}/schedule`,
        headers: bearer(token),
        payload: { scheduled_for: new Date(Date.now() + 3_600_000).toISOString() },
      });

      expect(res.statusCode).toBe(503);
      expect(await row(id)).toEqual(before);
      expect(before.scheduledFor).toBeNull();
      expect(offBroker.published).toHaveLength(eventsBefore);
    });

    it('does not touch a message that is already scheduled either', async () => {
      const id = await newDraft();
      await forceStatus(id, 'scheduled', new Date(Date.now() + 3_600_000).toISOString());
      const before = await row(id);
      const eventsBefore = offBroker.published.length;

      const res = await offApp.inject({ method: 'POST', url: `/v1/messages/${id}/send`, headers: bearer(token) });

      expect(res.statusCode).toBe(503);
      expect(await row(id)).toEqual(before);
      expect(offBroker.published).toHaveLength(eventsBefore);
    });

    it('still creates, lists and fetches drafts', async () => {
      const id = await newDraft();
      const got = await offApp.inject({ method: 'GET', url: `/v1/messages/${id}`, headers: bearer(token) });
      expect(got.statusCode).toBe(200);
      const listed = await offApp.inject({ method: 'GET', url: '/v1/messages', headers: bearer(token) });
      expect(listed.json().items.map((m: { message_id: string }) => m.message_id)).toContain(id);
    });
  });

  describe('POST /v1/messages/:id/mark-sent', () => {
    it('records a draft as sent by its owner without a transport, even with delivery off, and publishes outreach.sent once', async () => {
      const id = await newDraft();

      const res = await markSent(offApp, id, token);

      expect(res.statusCode).toBe(200);
      const { message } = res.json();
      // Same response shape as send/schedule/get: { message } carrying every Message field.
      expect(Object.keys(res.json())).toEqual(['message']);
      expect(Object.keys(message).sort()).toEqual(
        ['application_id', 'body', 'channel', 'contact_id', 'created_at', 'idempotency_key', 'message_id', 'scheduled_for', 'sent_at', 'status', 'subject', 'user_id'],
      );
      expect(message).toMatchObject({ message_id: id, status: 'sent', user_id: userId, scheduled_for: null });
      expect(message.sent_at).not.toBeNull();

      const stored = await row(id);
      expect(stored.status).toBe('sent');
      expect(stored.sentAt).not.toBeNull();

      const events = sentEventsFor(offBroker, id);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({ message_id: id, user_id: userId, contact_id: contactId, channel: 'email' });
      expect(events[0]!.event_id).toBe(derivedEventId(id, 'outreach.sent'));
    });

    it('accepts an optional note without storing or echoing it, and rejects an oversized one', async () => {
      const id = await newDraft();
      const note = 'sent from my own gmail';

      const res = await markSent(offApp, id, token, { note });
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json())).not.toContain(note);
      expect(JSON.stringify(await row(id))).not.toContain(note);
      expect(JSON.stringify(sentEventsFor(offBroker, id))).not.toContain(note);

      const other = await newDraft();
      const tooLong = await markSent(offApp, other, token, { note: 'x'.repeat(501) });
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json().error.code).toBe('VALIDATION_ERROR');
      expect((await row(other)).status).toBe('draft');
    });

    it('works from scheduled and keeps the scheduled time', async () => {
      const id = await newDraft();
      const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
      await forceStatus(id, 'scheduled', scheduledFor);

      const res = await markSent(offApp, id, token);

      expect(res.statusCode).toBe(200);
      expect(res.json().message.status).toBe('sent');
      expect(new Date((await row(id)).scheduledFor!).toISOString()).toBe(scheduledFor);
      expect(sentEventsFor(offBroker, id)).toHaveLength(1);
    });

    describe('ownership', () => {
      it("404s for someone else's message and changes nothing", async () => {
        const id = await newDraft();
        const before = await row(id);
        const eventsBefore = offBroker.published.length;

        const res = await markSent(offApp, id, otherToken);

        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('NOT_FOUND');
        expect(await row(id)).toEqual(before);
        expect(offBroker.published).toHaveLength(eventsBefore);
        // The owner can still record it afterwards: the failed attempt claimed nothing.
        expect((await markSent(offApp, id, token)).statusCode).toBe(200);
      });

      it('answers a message that does not exist exactly like one that is not yours', async () => {
        const id = await newDraft();
        const missing = await markSent(offApp, randomUUID(), token);
        const foreign = await markSent(offApp, id, otherToken);
        expect(missing.statusCode).toBe(404);
        expect({ ...missing.json().error, request_id: undefined }).toEqual({ ...foreign.json().error, request_id: undefined });
      });

      it('requires a token and a well-formed id', async () => {
        const id = await newDraft();
        expect((await offApp.inject({ method: 'POST', url: `/v1/messages/${id}/mark-sent` })).statusCode).toBe(401);
        expect((await markSent(offApp, 'not-a-uuid', token)).statusCode).toBe(400);
        expect((await row(id)).status).toBe('draft');
      });
    });

    describe('idempotency', () => {
      it('answers a repeat with the same message and emits no second event', async () => {
        const id = await newDraft();
        const first = await markSent(offApp, id, token);
        const second = await markSent(offApp, id, token);
        const third = await markSent(offApp, id, token, { note: 'again' });

        for (const res of [second, third]) {
          expect(res.statusCode).toBe(200);
          expect(res.json().message).toEqual(first.json().message);
        }
        expect(sentEventsFor(offBroker, id)).toHaveLength(1);
      });

      it('does not move sent_at on a repeat', async () => {
        const id = await newDraft();
        await markSent(offApp, id, token);
        const firstSentAt = (await row(id)).sentAt;
        await markSent(offApp, id, token);
        expect((await row(id)).sentAt).toBe(firstSentAt);
      });

      it('treats a message Atlas already sent (delivery on) the same way: 200, nothing new published', async () => {
        const id = await newDraft();
        const sent = await app.inject({ method: 'POST', url: `/v1/messages/${id}/send`, headers: bearer(token) });
        expect(sent.statusCode).toBe(200);
        expect(sentEventsFor(broker, id)).toHaveLength(1);

        const res = await markSent(app, id, token);

        expect(res.statusCode).toBe(200);
        expect(res.json().message.status).toBe('sent');
        expect(sentEventsFor(broker, id)).toHaveLength(1);
      });
    });

    describe('atomicity', () => {
      it('lets exactly one of many concurrent requests claim the message and publish', async () => {
        const id = await newDraft();

        const responses = await Promise.all(Array.from({ length: 10 }, () => markSent(offApp, id, token)));

        expect(responses.map((res) => res.statusCode)).toEqual(Array(10).fill(200));
        expect(new Set(responses.map((res) => res.json().message.sent_at)).size).toBe(1);
        expect(sentEventsFor(offBroker, id)).toHaveLength(1);
        expect((await row(id)).status).toBe('sent');
      });

      it.each<MessageStatus>(['failed', 'bounced', 'delivered', 'replied'])(
        'refuses a %s message with 409 and leaves it as it was',
        async (status) => {
          const id = await newDraft();
          await forceStatus(id, status);
          const before = await row(id);
          const eventsBefore = offBroker.published.length;

          const res = await markSent(offApp, id, token);

          expect(res.statusCode).toBe(409);
          expect(res.json().error.code).toBe('CONFLICT');
          expect(await row(id)).toEqual(before);
          expect(offBroker.published).toHaveLength(eventsBefore);
        },
      );

      it.each<{ from: 'draft' | 'scheduled' }>([{ from: 'draft' }, { from: 'scheduled' }])(
        'puts a $from message back when the event cannot be published, so a retry starts clean',
        async ({ from }) => {
          const id = await newDraft();
          if (from === 'scheduled') await forceStatus(id, 'scheduled', new Date(Date.now() + 3_600_000).toISOString());
          const before = await row(id);

          const brokenBroker = createBroker({ driver: 'memory', logger: createSilentLogger() }) as MemoryBroker;
          brokenBroker.publish = async () => {
            throw new Error('broker down');
          };
          const brokenApp = make({}, brokenBroker);
          await brokenApp.ready();

          const failed = await markSent(brokenApp, id, token);
          expect(failed.statusCode).toBe(500);
          // The failure is reported, not hidden, and the message is not left claimed.
          expect(await row(id)).toEqual(before);
          expect(before.status).toBe(from);
          expect(before.sentAt).toBeNull();

          const retried = await markSent(offApp, id, token);
          expect(retried.statusCode).toBe(200);
          expect(retried.json().message.status).toBe('sent');
          expect(sentEventsFor(offBroker, id)).toHaveLength(1);
        },
      );
    });
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

  it('with delivery on, sends the message via the local transport and publishes outreach.sent', async () => {
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
    // The suite above creates dozens of drafts; ask for a page big enough to hold them all.
    const res = await app.inject({ method: 'GET', url: '/v1/messages?limit=100', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((m: { message_id: string }) => m.message_id);
    expect(ids).toContain(messageId);

    const theirs = await app.inject({ method: 'GET', url: '/v1/messages?limit=100', headers: { authorization: `Bearer ${otherToken}` } });
    expect(theirs.json().items).toEqual([]);
  });
});
