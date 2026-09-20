import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';

type ConnectorAccountRow = typeof schema.connectorAccounts.$inferSelect;

export async function findByUserAndProvider(
  db: Database,
  userId: string,
  provider: string,
): Promise<ConnectorAccountRow | null> {
  const [row] = await db
    .select()
    .from(schema.connectorAccounts)
    .where(and(eq(schema.connectorAccounts.userId, userId), eq(schema.connectorAccounts.provider, provider)))
    .limit(1);
  return row ?? null;
}

export async function findByProviderAndExternalId(
  db: Database,
  provider: string,
  externalAccountId: string,
): Promise<ConnectorAccountRow | null> {
  const [row] = await db
    .select()
    .from(schema.connectorAccounts)
    .where(
      and(
        eq(schema.connectorAccounts.provider, provider),
        eq(schema.connectorAccounts.externalAccountId, externalAccountId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listForUser(db: Database, userId: string): Promise<ConnectorAccountRow[]> {
  return db.select().from(schema.connectorAccounts).where(eq(schema.connectorAccounts.userId, userId));
}

export interface InsertConnectionInput {
  userId: string;
  organizationId: string | null;
  provider: string;
  externalAccountId: string;
  secretRef: string;
  scopes: string[];
  consentGrantedAt: string;
}

export async function insertConnection(db: Database, input: InsertConnectionInput): Promise<ConnectorAccountRow> {
  const [row] = await db
    .insert(schema.connectorAccounts)
    .values({ ...input, status: 'active' })
    .returning();
  if (!row) throw new Error('insertConnection: insert returned no row');
  return row;
}

export interface ReplaceConnectionInput {
  connectorAccountId: string;
  externalAccountId: string;
  secretRef: string;
  scopes: string[];
  consentGrantedAt: string;
}

/** A user reconnecting the same provider replaces their existing row rather than accumulating duplicates. */
export async function replaceConnection(db: Database, input: ReplaceConnectionInput): Promise<ConnectorAccountRow> {
  const [row] = await db
    .update(schema.connectorAccounts)
    .set({
      externalAccountId: input.externalAccountId,
      secretRef: input.secretRef,
      scopes: input.scopes,
      consentGrantedAt: input.consentGrantedAt,
      status: 'active',
      lastError: null,
    })
    .where(eq(schema.connectorAccounts.connectorAccountId, input.connectorAccountId))
    .returning();
  if (!row) throw new Error('replaceConnection: connector account disappeared mid-update');
  return row;
}

export async function markRevoked(db: Database, connectorAccountId: string): Promise<ConnectorAccountRow> {
  const [row] = await db
    .update(schema.connectorAccounts)
    .set({ status: 'revoked' })
    .where(eq(schema.connectorAccounts.connectorAccountId, connectorAccountId))
    .returning();
  if (!row) throw new Error('markRevoked: connector account disappeared mid-update');
  return row;
}
