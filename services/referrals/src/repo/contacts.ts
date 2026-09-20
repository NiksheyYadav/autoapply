import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Contact, PaginationQuery } from '@atlas/types';
import { decodeCursor, encodeCursor } from '@atlas/utils';

type ContactRow = typeof schema.contacts.$inferSelect;

export function toContact(row: ContactRow): Contact {
  return {
    contact_id: row.contactId,
    company_id: row.companyId,
    full_name: row.fullName,
    title: row.title,
    email: row.email,
    linkedin_url: row.linkedinUrl,
    relevance_score: row.relevanceScore,
    created_at: row.createdAt,
  };
}

export async function findByCompanyAndEmail(
  db: Database,
  companyId: string,
  email: string,
): Promise<ContactRow | null> {
  const [row] = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.companyId, companyId), eq(schema.contacts.email, email)))
    .limit(1);
  return row ?? null;
}

export interface InsertContactInput {
  companyId: string;
  fullName: string | null;
  title: string | null;
  email: string | null;
  linkedinUrl: string | null;
  relevanceScore: number;
  source: string;
}

export async function insertContact(db: Database, input: InsertContactInput): Promise<ContactRow> {
  const [row] = await db.insert(schema.contacts).values(input).returning();
  if (!row) throw new Error('insertContact: insert returned no row');
  return row;
}

export interface ListForCompanyResult {
  items: ContactRow[];
  nextCursor: string | null;
}

/** Most relevant contacts first — the whole point of the relevance score. */
export async function listForCompany(
  db: Database,
  companyId: string,
  pagination: PaginationQuery,
): Promise<ListForCompanyResult> {
  const cursorValue = pagination.cursor ? decodeCursor(pagination.cursor) : null;
  const cursorScore = typeof cursorValue?.score === 'number' ? cursorValue.score : null;
  const cursorId = typeof cursorValue?.id === 'string' ? cursorValue.id : null;

  const conditions = [eq(schema.contacts.companyId, companyId)];
  if (cursorScore !== null && cursorId) {
    const tieBreak = or(
      lt(schema.contacts.relevanceScore, cursorScore),
      and(eq(schema.contacts.relevanceScore, cursorScore), lt(schema.contacts.contactId, cursorId)),
    );
    if (tieBreak) conditions.push(tieBreak);
  }

  const rows = await db
    .select()
    .from(schema.contacts)
    .where(and(...conditions))
    .orderBy(desc(schema.contacts.relevanceScore), desc(schema.contacts.contactId))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const items = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ score: last.relevanceScore ?? 0, id: last.contactId }) : null,
  };
}

/** Top N contacts for a company by relevance — used by the worker's single-company fan-out. */
export async function topContactsForCompany(db: Database, companyId: string, limit: number): Promise<ContactRow[]> {
  return db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.companyId, companyId))
    .orderBy(desc(schema.contacts.relevanceScore), desc(schema.contacts.contactId))
    .limit(limit);
}

/**
 * Batched sibling of `topContactsForCompany` for the multi-company read path
 * (`findReferralCandidatesForUser`) — one query for every company instead of
 * one per company. Grouping and the per-company `limit` happen in memory;
 * with a handful of companies and a curated contacts table this is far
 * cheaper than N round trips, without needing a window-function query.
 */
export async function topContactsForCompanies(
  db: Database,
  companyIds: string[],
  limitPerCompany: number,
): Promise<Map<string, ContactRow[]>> {
  const result = new Map<string, ContactRow[]>();
  if (companyIds.length === 0) return result;

  const rows = await db
    .select()
    .from(schema.contacts)
    .where(inArray(schema.contacts.companyId, companyIds))
    .orderBy(desc(schema.contacts.relevanceScore), desc(schema.contacts.contactId));

  for (const row of rows) {
    const bucket = result.get(row.companyId);
    if (bucket) {
      if (bucket.length < limitPerCompany) bucket.push(row);
    } else {
      result.set(row.companyId, [row]);
    }
  }
  return result;
}
