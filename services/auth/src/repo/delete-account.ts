import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { schema, type Database, type Transaction } from '@atlas/db';
import type { DeleteAccountBlocker } from '@atlas/types';
import { AppError } from '@atlas/utils';
import { recordAccountAudit, ACCOUNT_AUDIT_ACTIONS } from './audit.js';
import { analyticsEventsOf, outboxEventsOf, tasksOf } from './user-references.js';

export interface DeleteAccountOutcome {
  deletedAt: Date;
  /** Personal organizations the user was the last member of; they went with the account. */
  organizationsDeleted: number;
  /** Object-store keys of the user's resume files, collected before the rows holding them were deleted. */
  storageKeys: string[];
  /** False when there was nothing left to delete (a repeat of an earlier, completed request). */
  accountExisted: boolean;
}

function blocked(
  reason: DeleteAccountBlocker,
  message: string,
  organizations: Array<{ organization_id: string; name: string }> = [],
): AppError {
  return new AppError('CONFLICT', message, { details: { reason, organizations } });
}

/**
 * Hard-deletes everything held about `userId`, and the sign-in account itself, in
 * ONE transaction: either all of it is gone or none of it is.
 *
 * What removes what:
 *   - `delete from auth.users` is the root. public.users references it with ON
 *     DELETE CASCADE (packages/db/supabase/auth-hooks.sql), and every table that
 *     points at public.users cascades from there: organization_members, students,
 *     resumes, applications (and, through them, application_events and messages),
 *     messages, job_scores, connector_accounts, idempotency_keys. Doing it in this
 *     transaction, rather than after it, means a failure cannot leave a sign-in
 *     account behind with its data already gone.
 *   - Tables that would NOT be cleaned by that cascade are deleted explicitly:
 *       analytics_events   user_id is ON DELETE SET NULL, which would orphan the row
 *       event_outbox       user_id has no foreign key at all (by design)
 *       tasks              payload only, no user column
 *       audit_logs         the user's own account-level entries (resource = the user);
 *                          entries where the user acted inside an organization are kept
 *                          by design, with the actor set to null by its foreign key
 *     and the personal (`individual`) organizations the user was the last member of.
 *     An institutional organization (university, enterprise) is never deleted as a
 *     side effect of one person leaving: it is provisioned by platform administrators
 *     and outlives any member, so the user's membership goes and the organization stays.
 *   - Shared listings (jobs, companies, contacts) are not user data and stay.
 *
 * It refuses (409 CONFLICT) instead of deleting when doing so would strand other
 * people or a credential:
 *   - the user is the only owner of an organization that has other members;
 *   - the user, or an organization about to be deleted, still has a connected
 *     account. Its credential lives in the connector secret store, which this
 *     service cannot reach, and deleting the row would leave that credential with
 *     nothing pointing at it. The user disconnects first (connectors-service
 *     revokes the secret), and then deletion goes through.
 *
 * The one row that survives is a tombstone in audit_logs: action `account.deleted`,
 * resource_id = the user id, no actor, counts only.
 */
export async function deleteAccountData(
  db: Database,
  userId: string,
  traceId: string,
): Promise<DeleteAccountOutcome> {
  return db.transaction(async (tx) => {
    // Serialize concurrent deletes of the same account (a double click, a retry).
    const [publicAccount] = await tx
      .select({ userId: schema.users.userId })
      .from(schema.users)
      .where(eq(schema.users.userId, userId))
      .for('update');

    const authSchemaPresent = await hasAuthUsersTable(tx);
    const authAccountExisted = authSchemaPresent && (await authUserExists(tx, userId));
    const accountExisted = publicAccount !== undefined || authAccountExisted;

    const storageKeys = (
      await tx.select({ storageUrl: schema.resumes.storageUrl }).from(schema.resumes).where(eq(schema.resumes.userId, userId))
    ).map((row) => row.storageUrl);

    const orgsToDelete = await organizationsToDelete(tx, userId);

    const activeConnectors = await tx
      .select({ id: schema.connectorAccounts.connectorAccountId })
      .from(schema.connectorAccounts)
      .where(
        and(
          ne(schema.connectorAccounts.status, 'revoked'),
          or(
            eq(schema.connectorAccounts.userId, userId),
            orgsToDelete.length > 0
              ? inArray(
                  schema.connectorAccounts.organizationId,
                  orgsToDelete.map((org) => org.organization_id),
                )
              : undefined,
          ),
        ),
      )
      .limit(1);
    if (activeConnectors.length > 0) {
      throw blocked(
        'active_connected_accounts',
        'You still have a connected account. Disconnect it first, so its credential is revoked, then delete your account.',
      );
    }

    if (orgsToDelete.length > 0) {
      await tx.delete(schema.organizations).where(
        inArray(
          schema.organizations.organizationId,
          orgsToDelete.map((org) => org.organization_id),
        ),
      );
    }

    await tx.delete(schema.eventOutbox).where(outboxEventsOf(userId));
    await tx.delete(schema.analyticsEvents).where(analyticsEventsOf(userId));
    await tx.delete(schema.tasks).where(tasksOf(userId));
    await tx.delete(schema.auditLogs).where(
      and(
        eq(schema.auditLogs.resourceType, 'user'),
        eq(schema.auditLogs.resourceId, userId),
        // Not the tombstone an earlier, completed deletion of this account left behind.
        ne(schema.auditLogs.action, ACCOUNT_AUDIT_ACTIONS.deleted),
      ),
    );

    if (authSchemaPresent) {
      await tx.execute(sql`delete from auth.users where id = ${userId}`);
    }
    // The cascade above already removed this row where the foreign key exists. Doing it
    // explicitly covers a database without the Supabase auth schema (local development).
    await tx.delete(schema.users).where(eq(schema.users.userId, userId));

    const deletedAt = new Date();
    if (accountExisted) {
      await recordAccountAudit(tx, {
        action: ACCOUNT_AUDIT_ACTIONS.deleted,
        userId,
        actorUserId: null,
        traceId,
        metadata: { organizations_deleted: orgsToDelete.length, resume_files: storageKeys.length },
      });
    }

    return { deletedAt, organizationsDeleted: orgsToDelete.length, storageKeys, accountExisted };
  });
}

/** True on Supabase, and on test databases that load infra/ci/supabase-stub.sql; false on a plain Postgres. */
async function hasAuthUsersTable(tx: Transaction): Promise<boolean> {
  const rows = await tx.execute(sql`select to_regclass('auth.users') is not null as present`);
  return rows[0]?.present === true;
}

async function authUserExists(tx: Transaction, userId: string): Promise<boolean> {
  const rows = await tx.execute(sql`select 1 as present from auth.users where id = ${userId}`);
  return rows.length > 0;
}

/**
 * Looks at every organization the user belongs to (as a member or on its student
 * roster), locks them, and decides each one's fate:
 *   - the user is the only person in it and it is a personal workspace: it is
 *     deleted with the account;
 *   - the user is the only person in it and it is an institution: it stays, minus
 *     the user's rows;
 *   - others remain and the user is not their only owner: just the user's rows go;
 *   - others remain and the user is the only owner: deletion is refused.
 *
 * The locks (organization rows, then their membership rows, always in id order)
 * hold off a concurrent invite, role change or removal until this transaction
 * ends, so the decision cannot go stale underneath it.
 */
async function organizationsToDelete(
  tx: Transaction,
  userId: string,
): Promise<Array<{ organization_id: string; name: string }>> {
  const memberOf = await tx
    .select({ organizationId: schema.organizationMembers.organizationId })
    .from(schema.organizationMembers)
    .where(eq(schema.organizationMembers.userId, userId));
  const rosterOf = await tx
    .select({ organizationId: schema.students.organizationId })
    .from(schema.students)
    .where(eq(schema.students.userId, userId));

  const organizationIds = [...new Set([...memberOf, ...rosterOf].map((row) => row.organizationId))].sort();
  if (organizationIds.length === 0) return [];

  const organizations = await tx
    .select({
      organizationId: schema.organizations.organizationId,
      name: schema.organizations.name,
      type: schema.organizations.type,
    })
    .from(schema.organizations)
    .where(inArray(schema.organizations.organizationId, organizationIds))
    .orderBy(asc(schema.organizations.organizationId))
    .for('update');

  const members = await tx
    .select({
      organizationId: schema.organizationMembers.organizationId,
      userId: schema.organizationMembers.userId,
      role: schema.organizationMembers.role,
    })
    .from(schema.organizationMembers)
    .where(inArray(schema.organizationMembers.organizationId, organizationIds))
    .orderBy(asc(schema.organizationMembers.organizationId), asc(schema.organizationMembers.userId))
    .for('update');

  const roster = await tx
    .select({ organizationId: schema.students.organizationId, userId: schema.students.userId })
    .from(schema.students)
    .where(inArray(schema.students.organizationId, organizationIds));

  const toDelete: Array<{ organization_id: string; name: string }> = [];
  const soleOwnerOf: Array<{ organization_id: string; name: string }> = [];

  for (const organization of organizations) {
    const orgMembers = members.filter((row) => row.organizationId === organization.organizationId);
    const otherMembers = orgMembers.filter((row) => row.userId !== userId);
    const otherStudents = roster.filter(
      (row) => row.organizationId === organization.organizationId && row.userId !== userId,
    );
    const summary = { organization_id: organization.organizationId, name: organization.name };

    if (otherMembers.length === 0 && otherStudents.length === 0) {
      // Nobody else is in it. A personal workspace goes with its only member; an institution stays.
      if (organization.type === 'individual') toDelete.push(summary);
      continue;
    }

    const ownsIt = orgMembers.some((row) => row.userId === userId && row.role === 'owner');
    const anotherOwner = otherMembers.some((row) => row.role === 'owner');
    if (ownsIt && !anotherOwner) soleOwnerOf.push(summary);
  }

  if (soleOwnerOf.length > 0) {
    throw blocked(
      'sole_owner_of_organization',
      'You are the only owner of an organization that has other members. Make another member an owner, or remove the other members, then delete your account.',
      soleOwnerOf,
    );
  }

  return toDelete;
}
