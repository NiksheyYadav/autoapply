import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBroker, createEvent, type EventBroker, type Subscription } from '@atlas/messaging';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { newTraceContext } from '@atlas/utils';
import { createSilentLogger } from '@atlas/utils';
import { registerConsumers } from '../src/worker.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('matching-service worker', () => {
  let dbHandle: DatabaseHandle;
  let broker: EventBroker;
  let subscriptions: Subscription[];
  const userId = randomUUID();
  const email = `matching-flow-${userId}@example.com`;
  const companyName = `Matching Test Co ${randomUUID().slice(0, 8)}`;
  let companyId: string;

  beforeAll(async () => {
    dbHandle = createDatabase({ url: testDatabaseUrl as string });
    broker = createBroker({ driver: 'memory', logger: createSilentLogger() });
    subscriptions = await registerConsumers({ db: dbHandle.db, broker, logger: createSilentLogger() });

    await dbHandle.db.insert(schema.users).values({
      userId,
      email,
      fullName: 'Matching Flow Test User',
      authProvider: 'password',
    });
    const [company] = await dbHandle.db
      .insert(schema.companies)
      .values({ name: companyName, normalizedName: companyName.toLowerCase() })
      .returning();
    companyId = company!.companyId;
  });

  afterAll(async () => {
    await Promise.all(subscriptions.map((subscription) => subscription.stop()));
    await dbHandle.db.delete(schema.jobScores).where(eq(schema.jobScores.userId, userId));
    await dbHandle.db.delete(schema.jobs).where(eq(schema.jobs.companyId, companyId));
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.companyId, companyId));
    await dbHandle.db.delete(schema.resumes).where(eq(schema.resumes.userId, userId));
    await dbHandle.db.delete(schema.users).where(eq(schema.users.userId, userId));
    await broker.close();
    await dbHandle.close();
  });

  it('scores an existing active job when a resume finishes parsing, and re-scoring upserts rather than duplicates', async () => {
    const [job] = await dbHandle.db
      .insert(schema.jobs)
      .values({
        companyId,
        title: 'Backend Engineer',
        source: 'manual',
        jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        skills: ['typescript', 'postgresql'],
        isActive: true,
      })
      .returning();

    await dbHandle.db.insert(schema.resumes).values({
      userId,
      storageUrl: `resumes/${userId}/seed`,
      originalFilename: 'resume.txt',
      contentType: 'text/plain',
      byteSize: 10,
      contentHash: randomUUID(),
      status: 'parsed',
      parsedProfile: {
        full_name: 'Test Candidate',
        headline: null,
        summary: null,
        contact: { email: null, phone: null, location: null, links: [] },
        skills: [{ name: 'typescript', raw: 'TypeScript', months_experience: 24 }],
        experience: [],
        education: [],
        certifications: [],
        keywords: [],
        total_months_experience: 24,
      },
      parsedAt: new Date().toISOString(),
    });

    await broker.publish(
      createEvent(
        'resume.parsed',
        { resume_id: randomUUID(), user_id: userId, ats_score: 80, skill_count: 1, total_months_experience: 24 },
        newTraceContext({ user_id: userId }),
      ),
    );

    const [scoreRow] = await dbHandle.db
      .select()
      .from(schema.jobScores)
      .where(and(eq(schema.jobScores.jobId, job!.jobId), eq(schema.jobScores.userId, userId)));
    expect(scoreRow).toBeDefined();
    expect(scoreRow!.score).toBeGreaterThan(0);
    expect(scoreRow!.skillGaps).toEqual(['postgresql']);
    const firstScoredAt = scoreRow!.scoredAt;

    // Re-publish: the same (job, user) pair must upsert, not duplicate.
    await broker.publish(
      createEvent(
        'resume.parsed',
        { resume_id: randomUUID(), user_id: userId, ats_score: 80, skill_count: 1, total_months_experience: 24 },
        newTraceContext({ user_id: userId }),
      ),
    );
    const rows = await dbHandle.db
      .select()
      .from(schema.jobScores)
      .where(and(eq(schema.jobScores.jobId, job!.jobId), eq(schema.jobScores.userId, userId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scoredAt >= firstScoredAt).toBe(true);
  });

  it('scores a newly discovered job against an existing candidate with a parsed resume', async () => {
    const [job] = await dbHandle.db
      .insert(schema.jobs)
      .values({
        companyId,
        title: 'Senior Backend Engineer',
        source: 'manual',
        jobHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        skills: ['typescript'],
        isActive: true,
      })
      .returning();

    await broker.publish(
      createEvent(
        'job.discovered',
        { job_id: job!.jobId, company_id: companyId, source: 'manual', job_hash: job!.jobHash, title: job!.title },
        newTraceContext(),
      ),
    );

    const [scoreRow] = await dbHandle.db
      .select()
      .from(schema.jobScores)
      .where(and(eq(schema.jobScores.jobId, job!.jobId), eq(schema.jobScores.userId, userId)));
    expect(scoreRow).toBeDefined();
  });
});
