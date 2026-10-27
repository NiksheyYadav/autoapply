import { schema, type Queryable } from '@atlas/db';

export const ACCOUNT_AUDIT_ACTIONS = {
  export: 'account.export',
  deleted: 'account.deleted',
} as const;

export type AccountAuditAction = (typeof ACCOUNT_AUDIT_ACTIONS)[keyof typeof ACCOUNT_AUDIT_ACTIONS];

/**
 * Counts only. Free-form strings are not allowed, so no name, email or file name
 * can end up in the audit trail (docs/09 § Data protection).
 */
export type AccountAuditMetadata = Record<string, number | boolean>;

/**
 * Appends one row to `audit_logs` about an account-level action. The only
 * identifier recorded is the user id.
 *
 * For `account.export` the caller is the actor. For `account.deleted` there is no
 * actor to point at (the account is gone by the time the row is written, and the
 * column is a foreign key to it), so it is null and the user id is carried by
 * `resource_id` alone. That one row is the only thing that outlives a deletion.
 */
export async function recordAccountAudit(
  db: Queryable,
  entry: {
    action: AccountAuditAction;
    userId: string;
    actorUserId: string | null;
    /** Request id, so the entry can be joined to the request log. */
    traceId: string;
    metadata?: AccountAuditMetadata;
  },
): Promise<void> {
  await db.insert(schema.auditLogs).values({
    organizationId: null,
    actorUserId: entry.actorUserId,
    action: entry.action,
    resourceType: 'user',
    resourceId: entry.userId,
    traceId: entry.traceId,
    metadata: entry.metadata ?? {},
  });
}
