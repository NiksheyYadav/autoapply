import { schema, type Queryable } from '@atlas/db';

export interface AuditEntry {
  organizationId: string | null;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  traceId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Append-only by convention (docs/09 § Compliance posture) — never update or delete a row. */
export async function writeAuditLog(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.insert(schema.auditLogs).values({
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    traceId: entry.traceId ?? null,
    metadata: entry.metadata ?? {},
  });
}
