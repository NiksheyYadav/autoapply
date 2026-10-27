import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type DatabaseHandle } from '@atlas/db';
import { listForUser } from '../src/repo/scores.js';

// DB-backed tests self-skip when ATLAS_TEST_DATABASE_URL is unset (see .env.example).
const testDatabaseUrl = process.env.ATLAS_TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('recommendations and deactivated postings, against Postgres', () => {
  let dbHandle: DatabaseHandle;
  const tag = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const companyName = `Recs Co ${tag}`;

  beforeAll(async () => {
    dbHandle = createDatabase({ url: testDatabaseUrl!, maxConnections: 2 });
    const { db, sql } = dbHandle;

    // A real signup, so the handle_new_user trigger creates the public.users row job_scores points at.
    await sql`
      INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      VALUES (${userId}, ${`recs-${tag}@example.com`}, now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now())`;

    const [company] = await db.insert(schema.companies).values({ name: companyName, normalizedName: companyName.toLowerCase() }).returning();
    const jobs = await db
      .insert(schema.jobs)
      .values([
        { companyId: company!.companyId, title: `Open ${tag}`, source: 'manual', jobHash: `open-${tag}`.padEnd(64, '0'), isActive: true },
        { companyId: company!.companyId, title: `Closed ${tag}`, source: 'manual', jobHash: `closed-${tag}`.padEnd(64, '0'), isActive: false },
      ])
      .returning();
    await db.insert(schema.jobScores).values(
      jobs.map((job) => ({ jobId: job.jobId, userId, score: job.isActive ? 0.8 : 0.95, reasons: ['skills'], modelVersion: 'test' })),
    );
  });

  afterAll(async () => {
    await dbHandle.db.delete(schema.companies).where(eq(schema.companies.name, companyName));
    await dbHandle.sql`DELETE FROM auth.users WHERE id = ${userId}`;
    await dbHandle.close();
  });

  it('does not recommend a posting that has been deactivated, even with the better score', async () => {
    const page = await listForUser(dbHandle.db, userId, {}, { limit: 10 });

    expect(page.items.map((item) => item.job.title)).toEqual([`Open ${tag}`]);
    expect(page.items[0]?.job.is_active).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it('recommends it again if its source lists it again', async () => {
    await dbHandle.db.update(schema.jobs).set({ isActive: true }).where(eq(schema.jobs.title, `Closed ${tag}`));

    const page = await listForUser(dbHandle.db, userId, {}, { limit: 10 });

    // Highest score first.
    expect(page.items.map((item) => item.job.title)).toEqual([`Closed ${tag}`, `Open ${tag}`]);
  });
});
