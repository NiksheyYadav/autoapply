import { eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { normalizeCompanyName } from '../lib/normalize.js';

type CompanyRow = typeof schema.companies.$inferSelect;

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

export async function findOrCreateByName(
  db: Database,
  name: string,
  website?: string | null,
): Promise<CompanyRow> {
  const normalizedName = normalizeCompanyName(name);
  const [existing] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.normalizedName, normalizedName))
    .limit(1);
  if (existing) return existing;

  try {
    const [created] = await db
      .insert(schema.companies)
      .values({ name, normalizedName, website: website ?? null })
      .returning();
    if (!created) throw new Error('findOrCreateByName: insert returned no row');
    return created;
  } catch (cause) {
    // Two ingests racing to create the same company for the first time.
    if ((cause as { code?: string }).code === UNIQUE_VIOLATION) {
      const [raced] = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.normalizedName, normalizedName))
        .limit(1);
      if (raced) return raced;
    }
    throw cause;
  }
}
