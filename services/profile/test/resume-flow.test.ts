import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBroker } from '@atlas/messaging';
import { createStorage } from '@atlas/storage';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadProfileServiceEnv } from '../src/env.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

const JWT_SECRET = 'x'.repeat(32);

function buildMultipartBody(
  boundary: string,
  fields: Record<string, string>,
  file: { filename: string; contentType: string; data: Buffer },
): Buffer {
  const CRLF = '\r\n';
  const parts: (string | Buffer)[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`);
  }
  parts.push(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${file.filename}"${CRLF}` +
      `Content-Type: ${file.contentType}${CRLF}${CRLF}`,
  );
  parts.push(file.data);
  parts.push(`${CRLF}--${boundary}--${CRLF}`);
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'))));
}

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

describe.skipIf(!testDatabaseUrl)('profile-service HTTP flow', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let storageRoot: string;
  let token: string;
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const email = `profile-flow-${userId}@example.com`;
  const otherEmail = `profile-flow-${otherUserId}@example.com`;

  beforeAll(async () => {
    const env = loadProfileServiceEnv({
      DATABASE_URL: testDatabaseUrl,
      PORT: '4002',
      JWT_SECRET,
    });
    dbHandle = createDatabase({ url: env.DATABASE_URL });

    // profile-service never creates users — a real one has to exist for the
    // resumes.user_id foreign key, same as it would via a real auth-service signup.
    await dbHandle.db.insert(schema.users).values([
      { userId, email, fullName: 'Profile Flow Test User', authProvider: 'password' },
      { userId: otherUserId, email: otherEmail, fullName: 'Someone Else', authProvider: 'password' },
    ]);

    storageRoot = await mkdtemp(join(tmpdir(), 'atlas-profile-test-'));
    const storage = createStorage({ driver: 'local', localRoot: storageRoot });
    const broker = createBroker({ driver: 'memory', logger: createSilentLogger() });

    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      broker,
      storage,
      tokenVerifier: { secret: new TextEncoder().encode(JWT_SECRET), issuer: 'atlas', audience: 'atlas-clients' },
    });
    await app.ready();

    token = await signTestToken({ sub: userId, sid: randomUUID(), org: null, role: null, email });
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, userId));
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, otherUserId));
    await app.close();
    await dbHandle.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('rejects an unauthenticated upload', async () => {
    const boundary = 'boundary1';
    const body = buildMultipartBody(boundary, {}, { filename: 'r.txt', contentType: 'text/plain', data: Buffer.from('hi') });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a file sent under a field name other than "file"', async () => {
    const boundary = 'boundary-wrong-field';
    const CRLF = '\r\n';
    const body = Buffer.concat(
      [
        `--${boundary}${CRLF}Content-Disposition: form-data; name="resume"; filename="r.txt"${CRLF}Content-Type: text/plain${CRLF}${CRLF}`,
        'hello',
        `${CRLF}--${boundary}--${CRLF}`,
      ].map((p) => Buffer.from(p, 'utf8')),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('uploads, parses, and retrieves a resume; re-uploading the same bytes is idempotent', async () => {
    const resumeText = [
      'Ada Lovelace',
      '',
      'Summary',
      'Backend engineer with a focus on distributed systems.',
      '',
      'Experience',
      'Staff Engineer, Analytical Engines Inc',
      'Jan 2021 - Present',
      '- Cut P99 latency by 40% via a queue-based rewrite',
      '',
      'Skills',
      'TypeScript, PostgreSQL, Docker',
    ].join('\n');

    const boundary = 'boundary2';
    const body = buildMultipartBody(
      boundary,
      { source: 'upload' },
      { filename: 'resume.txt', contentType: 'text/plain', data: Buffer.from(resumeText, 'utf8') },
    );

    const uploadRes = await app.inject({
      method: 'POST',
      url: '/v1/resumes',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(201);
    const uploaded = uploadRes.json();
    expect(uploaded.status).toBe('parsed');

    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/resumes/${uploaded.resume_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    const { resume } = getRes.json();
    expect(resume.parsed_profile.skills.map((s: { name: string }) => s.name)).toContain('typescript');
    expect(resume.ats_score).toBeGreaterThan(0);

    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/resumes',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.some((r: { resume_id: string }) => r.resume_id === uploaded.resume_id)).toBe(true);

    // Re-upload of the exact same bytes should be a no-op, not a duplicate row.
    const boundary2 = 'boundary3';
    const body2 = buildMultipartBody(
      boundary2,
      { source: 'upload' },
      { filename: 'resume.txt', contentType: 'text/plain', data: Buffer.from(resumeText, 'utf8') },
    );
    const reuploadRes = await app.inject({
      method: 'POST',
      url: '/v1/resumes',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary2}` },
      payload: body2,
    });
    expect(reuploadRes.statusCode).toBe(200);
    expect(reuploadRes.json().resume_id).toBe(uploaded.resume_id);
  });

  it("404s when fetching another user's resume", async () => {
    const otherToken = await signTestToken({ sub: otherUserId, sid: randomUUID(), org: null, role: null, email: otherEmail });
    const boundary = 'boundary4';
    const body = buildMultipartBody(
      boundary,
      {},
      { filename: 'r.txt', contentType: 'text/plain', data: Buffer.from('a private resume') },
    );
    const uploadRes = await app.inject({
      method: 'POST',
      url: '/v1/resumes',
      headers: { authorization: `Bearer ${otherToken}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    const { resume_id } = uploadRes.json();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/resumes/${resume_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
