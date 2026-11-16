import { schema, type Queryable } from '@atlas/db';

export const AUDIT_ACTIONS = {
  studentsImport: 'admin.students.import',
  studentsExport: 'admin.students.export',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Metadata is restricted by type to counts, flags and a closed set of tokens.
 * Free-form strings are not allowed, so an email address, a name or a search
 * term cannot end up in the audit trail by accident (docs/09 § Data protection).
 */
export type AuditToken = 'csv' | 'json' | 'search' | 'has_resume' | 'application_status';
export type AuditMetadata = Record<string, number | boolean | null | AuditToken | AuditToken[]>;

export interface AuditEntry {
  organizationId: string;
  actorUserId: string;
  action: AuditAction;
  /** Request id, so the entry can be joined to the request log. */
  traceId: string;
  metadata: AuditMetadata;
}

/** Appends one row to `audit_logs`. Pass a transaction to commit it atomically with the audited change. */
export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.insert(schema.auditLogs).values({
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    resourceType: 'student_roster',
    resourceId: entry.organizationId,
    traceId: entry.traceId,
    metadata: entry.metadata,
  });
}
