import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createBroker } from '@atlas/messaging';
import { createStorage } from '@atlas/storage';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { optimizeResumeResponseSchema } from '@atlas/types';
import { createSilentLogger } from '@atlas/utils';
import { buildApp } from '../src/app.js';
import { loadProfileServiceEnv } from '../src/env.js';

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

function buildMultipartBody(boundary: string, file: { filename: string; contentType: string; data: Buffer }): Buffer {
  const CRLF = '\r\n';
  return Buffer.concat([
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${file.filename}"${CRLF}` +
        `Content-Type: ${file.contentType}${CRLF}${CRLF}`,
      'utf8',
    ),
    file.data,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'),
  ]);
}

const RESUME_TEXT = [
  'Ada Lovelace',
  'ada@example.com',
  '',
  'Summary',
  'Backend engineer with a focus on distributed systems.',
  '',
  'Experience',
  'Staff Engineer, Analytical Engines Inc',
  'Jan 2021 - Present',
  '- Cut P99 latency by 40% via a queue-based rewrite',
  '- Responsible for the on-call rotation',
  '',
  'Skills',
  'TypeScript, PostgreSQL, Docker',
].join('\n');

describe.skipIf(!testDatabaseUrl)('profile-service resume optimization', () => {
  let app: FastifyInstance;
  let dbHandle: DatabaseHandle;
  let storageRoot: string;
  let token: string;
  let otherToken: string;
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const email = `optimize-flow-${userId}@example.com`;
  const otherEmail = `optimize-flow-${otherUserId}@example.com`;
  const companyName = `Optimize Test Co ${randomUUID().slice(0, 8)}`;
  let companyId: string;
  let jobId: string;
  let resumeId: string;

  async function upload(authToken: string, text: string): Promise<string> {
    const boundary = `boundary-${randomUUID()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/resumes',
      headers: { authorization: `Bearer ${authToken}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: buildMultipartBody(boundary, { filename: 'resume.txt', contentType: 'text/plain', data: Buffer.from(text, 'utf8') }),
    });
    expect(res.statusCode).toBe(201);
    return res.json().resume_id as string;
  }

  function optimize(authToken: string | null, id: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: `/v1/resumes/${id}/optimize`,
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
      payload: body as object,
    });
  }

  beforeAll(async () => {
    await stubJwks();
    const env = loadProfileServiceEnv({ DATABASE_URL: testDatabaseUrl, PORT: '4002', SUPABASE_URL });
    dbHandle = createDatabase({ url: env.DATABASE_URL });

    // public.users.user_id FKs to auth.users.id (see packages/db/supabase/auth-hooks.sql);
    // inserting into auth.users fires handle_new_user, which creates the matching
    // public.users row itself — no separate insert needed.
    for (const u of [
      { id: userId, email, fullName: 'Optimize Flow Test User' },
      { id: otherUserId, email: otherEmail, fullName: 'Someone Else' },
    ]) {
      await dbHandle.sql`
        insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values (${u.id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${u.email}, now(), '{"provider":"email"}'::jsonb, ${JSON.stringify({ full_name: u.fullName })}::jsonb, now(), now())
      `;
    }

    storageRoot = await mkdtemp(join(tmpdir(), 'atlas-optimize-test-'));
    app = buildApp({
      db: dbHandle.db,
      sql: dbHandle.sql,
      env,
      logger: createSilentLogger(),
      broker: createBroker({ driver: 'memory', logger: createSilentLogger() }),
      storage: createStorage({ driver: 'local', localRoot: storageRoot }),
      tokenVerifier: createTokenVerifierConfig(env),
    });
    await app.ready();

    token = await signTestToken({ sub: userId, sid: randomUUID(), org: null, role: null, email });
    otherToken = await signTestToken({ sub: otherUserId, sid: randomUUID(), org: null, role: null, email: otherEmail });

    const [company] = await dbHandle.db
      .insert(schema.companies)
      .values({ name: companyName, normalizedName: companyName.toLowerCase() })
      .returning();
    companyId = company!.companyId;
    const [job] = await dbHandle.db
      .insert(schema.jobs)
      .values({
        companyId,
        title: 'Platform Engineer',
        description: 'Run Kubernetes clusters and ship TypeScript services.',
        source: 'manual',
        jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        skills: ['typescript', 'kubernetes'],
        isActive: true,
      })
      .returning();
    jobId = job!.jobId;

    resumeId = await upload(token, RESUME_TEXT);
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.resumes).where(eq(schema.resumes.userId, userId));
    await dbHandle.db.delete(schema.resumes).where(eq(schema.resumes.userId, otherUserId));
    await dbHandle.db.delete(schema.jobs).where(eq(schema.jobs.companyId, companyId));
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.companyId, companyId));
    // Cascades to public.users via the auth.users FK.
    await dbHandle.sql`delete from auth.users where id in (${userId}, ${otherUserId})`;
    await app.close();
    await dbHandle.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('requires authentication', async () => {
    const res = await optimize(null, resumeId, { job_id: jobId });
    expect(res.statusCode).toBe(401);
  });

  it('returns a keyword and bullet report for a parsed resume against a job', async () => {
    const res = await optimize(token, resumeId, { job_id: jobId });
    expect(res.statusCode).toBe(200);

    // The response must satisfy the shared contract, not just "look right".
    const body = optimizeResumeResponseSchema.parse(res.json());
    expect(body.resume_id).toBe(resumeId);
    expect(body.job_id).toBe(jobId);
    expect(body.report.keyword_match.matched).toContain('typescript');
    expect(body.report.keyword_match.missing).toEqual(['kubernetes']);
    expect(body.report.keyword_match.score).toBe(50);
    expect(
      body.report.bullet_findings.some((f) => f.bullet === 'Responsible for the on-call rotation' && f.issues.includes('weak_opening')),
    ).toBe(true);
    expect(body.report.recommendations.join(' ')).toMatch(/kubernetes/i);
  });

  it('is read-only: the resume row is unchanged after optimizing', async () => {
    const before = await dbHandle.db.select().from(schema.resumes).where(eq(schema.resumes.resumeId, resumeId));
    await optimize(token, resumeId, { job_id: jobId });
    const after = await dbHandle.db.select().from(schema.resumes).where(eq(schema.resumes.resumeId, resumeId));
    expect(after).toEqual(before);
  });

  it('rejects a malformed body or resume id with 400, not a 500', async () => {
    const badBody = await optimize(token, resumeId, { job_id: 'not-a-uuid' });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json().error.code).toBe('VALIDATION_ERROR');

    const missingBody = await optimize(token, resumeId, {});
    expect(missingBody.statusCode).toBe(400);

    const badId = await optimize(token, 'not-a-uuid', { job_id: jobId });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('404s for an unknown job', async () => {
    const res = await optimize(token, resumeId, { job_id: randomUUID() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('JOB_NOT_FOUND');
  });

  it("404s for another user's resume without confirming it exists", async () => {
    const otherResumeId = await upload(otherToken, 'Someone Else\nsomeone@example.com\n\nSkills\nPython');

    const res = await optimize(token, otherResumeId, { job_id: jobId });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RESUME_NOT_FOUND');

    const unknown = await optimize(token, randomUUID(), { job_id: jobId });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: { ...unknown.json().error, request_id: expect.any(String) } });
    expect(unknown.json().error.code).toBe(res.json().error.code);
  });

  it('409s for a resume that has not been parsed', async () => {
    const [pending] = await dbHandle.db
      .insert(schema.resumes)
      .values({
        userId,
        storageUrl: 'pending/key',
        originalFilename: 'pending.txt',
        contentType: 'text/plain',
        byteSize: 10,
        contentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        status: 'pending',
      })
      .returning();

    const res = await optimize(token, pending!.resumeId, { job_id: jobId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });
});
