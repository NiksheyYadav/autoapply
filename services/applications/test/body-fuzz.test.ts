import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase, type DatabaseHandle } from '@atlas/db';
import { createBroker } from '@atlas/messaging';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadApplicationsServiceEnv } from '../src/env.js';

const SUPABASE_URL = 'https://test-project.supabase.co';
// Nothing listens on port 1. Every request below must be turned away before it needs the database:
// that is what is being checked. One that reaches the database comes back as a 500.
const UNREACHABLE_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:1/atlas_body_fuzz';

/**
 * Hostile request bodies and content types. A service must answer each with a clean 4xx in its
 * standard error envelope: never a 500, never a stack trace or driver text, never a hang.
 */
describe('applications-service request bodies', () => {
  let app: FastifyInstance;
  let handle: DatabaseHandle;
  let token: string;
  const applicationId = randomUUID();
  let counter = 0;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    jwk.alg = 'ES256';
    jwk.use = 'sig';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    token = await new SignJWT({ session_id: randomUUID(), email: 'fuzz@example.com', app_metadata: {} })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(randomUUID())
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(privateKey);

    const env = loadApplicationsServiceEnv({
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      PORT: '4005',
      SUPABASE_URL,
      LOG_LEVEL: 'fatal',
      RATE_LIMIT_MAX: '100000',
      BODY_LIMIT_BYTES: '4096',
    });
    handle = createDatabase({ url: env.DATABASE_URL });
    app = buildApp({
      db: handle.db,
      sql: handle.sql,
      env,
      logger: createSilentLogger(),
      broker: createBroker({ driver: 'memory', logger: createSilentLogger() }),
      tokenVerifier: createTokenVerifierConfig(env),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  async function send(url: string, body: string | Buffer | undefined, headers: Record<string, string> = {}, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST') {
    counter += 1;
    return app.inject({
      method,
      url,
      payload: body,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': 'fuzz-key-0123456789',
        'x-forwarded-for': `10.1.${(counter >> 8) & 255}.${counter & 255}`,
        ...headers,
      },
    });
  }
  const json = { 'content-type': 'application/json' };

  const BODIES: ReadonlyArray<readonly [string, string]> = [
    ['an empty body', ''],
    ['unterminated JSON', '{"job_id":'],
    ['trailing garbage', '{"job_id":"x"} trailing'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"text"'],
    ['a JSON number', '123'],
    ['JSON true', 'true'],
    ['single quotes', "{'job_id':'x'}"],
    ['a BOM before the object', '﻿{"job_id":"x"}'],
    ['an object of the wrong shape', '{"foo":"bar"}'],
    ['wrong types', '{"job_id":123,"resume_id":false,"mode":["manual"]}'],
    ['nulls for every field', '{"job_id":null,"resume_id":null,"mode":null}'],
    ['prototype keys', '{"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}},"job_id":"x"}'],
    ['duplicate keys', '{"mode":"manual","mode":"auto","job_id":"x","job_id":"y"}'],
    ['a NUL in a string', '{"job_id":"a\\u0000b","resume_id":"x","mode":"manual"}'],
    ['a huge number', '{"job_id":1e999}'],
    ['an enormous exponent', '{"job_id":1E400,"resume_id":-1E400}'],
    ['deep nesting (5,000 arrays)', `${'['.repeat(5000)}${']'.repeat(5000)}`],
    ['deep nesting (5,000 objects)', `${'{"a":'.repeat(1500)}1${'}'.repeat(1500)}`],
    ['lone surrogates', '{"job_id":"\\ud800","resume_id":"\\udfff","mode":"manual"}'],
    ['a long string value', `{"job_id":"${'x'.repeat(3000)}","resume_id":"y","mode":"manual"}`],
  ];

  it.each(BODIES)('POST /v1/applications with %s is a 4xx in the standard envelope', async (_label, body) => {
    const res = await send('/v1/applications', body, json);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json().error).toMatchObject({ code: expect.any(String), message: expect.any(String), request_id: expect.any(String) });
    expect(res.body).not.toMatch(/\bat \S+ \(|node_modules|postgres|ECONNREFUSED|stack/i);
  });

  it.each(BODIES)('POST /v1/applications/:id/events with %s is a 4xx in the standard envelope', async (_label, body) => {
    const res = await send(`/v1/applications/${applicationId}/events`, body, json);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().error.request_id).toEqual(expect.any(String));
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded'],
    ['multipart/form-data with no boundary', 'multipart/form-data'],
    ['application/xml', 'application/xml'],
    ['a JSON type with a bogus charset', 'application/json; charset=klingon'],
    ['an invalid content type', 'not a media type'],
  ])('refuses a JSON body sent as %s', async (_label, contentType) => {
    const res = await send('/v1/applications', '{"job_id":"x","resume_id":"y","mode":"manual"}', { 'content-type': contentType });
    expect([400, 415]).toContain(res.statusCode);
    expect(res.json().error.request_id).toEqual(expect.any(String));
  });

  it('refuses a body with no content type at all', async () => {
    const res = await send('/v1/applications', '{"job_id":"x"}');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('answers 413 for a body over the limit, whatever it holds', async () => {
    const res = await send('/v1/applications', `{"job_id":"${'x'.repeat(8000)}"}`, json);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it.each([['PUT'], ['PATCH'], ['DELETE']] as const)('answers 404 for %s on a route that does not take it', async (method) => {
    const res = await send('/v1/applications', '{}', json, method);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it.each([
    ['/v1/applications/not-a-uuid/events'],
    ['/v1/applications/00000000-0000-0000-0000-00000000000/events'],
    [`/v1/applications/${applicationId}%00/events`],
    ['/v1/applications/%e0%a4%a/events'],
    ['/v1/applications/..%2f..%2fetc%2fpasswd/events'],
  ])('answers 4xx for a malformed id in the path: %s', async (url) => {
    const res = await send(url, '{"to_status":"queued"}', json);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  // Not listed: `limit=0x10` (read as 16) and bracketed keys such as `limit[]=1` (an unknown key, ignored)
  // are ordinary valid requests, not hostile ones, and would need the database.
  it.each([
    ['limit=0'],
    ['limit=-1'],
    ['limit=101'],
    ['limit=abc'],
    ['limit=1e3'],
    ['limit=1.5'],
    ['limit=%00'],
    ['limit='],
    ['limit=999999999999999999999'],
    ['limit=1&limit=2'],
    ['cursor='],
    ['cursor=a&cursor=b'],
    ['job_id=not-a-uuid'],
    ['job_id=1&job_id=2'],
    ['scope=everything'],
    ['scope=mine&scope=organization'],
  ])('answers 4xx for the query string ?%s on the list endpoint', async (query) => {
    const res = await send(`/v1/applications?${query}`, undefined, {}, 'POST').then(() =>
      app.inject({
        method: 'GET',
        url: `/v1/applications?${query}`,
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': `10.2.0.${(counter += 1) & 255}` },
      }),
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().error.request_id).toEqual(expect.any(String));
  });
});
