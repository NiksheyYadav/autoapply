import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Transaction } from '@atlas/db';
import type { ValidImportRow } from '../lib/import-rows.js';

const { students, users } = schema;

/** Keeps every statement far below Postgres' 65,535 bind-parameter limit. */
const LOOKUP_CHUNK = 1_000;
const WRITE_CHUNK = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    out.push(items.slice(start, start + size));
  return out;
}

export interface ApplyImportResult {
  created: number;
  updated: number;
  /** Already on the roster with these values (or created concurrently by another import). */
  unchanged: number;
  /** No live platform account has this email. */
  noPlatformAccount: number;
}

/**
 * Applies de-duplicated, validated rows to the roster, inside the caller's
 * transaction. Set-based: the number of statements grows with rows / 500, not
 * with rows.
 *
 * Each row is linked to the platform account with the same email
 * (case-insensitive, soft-deleted accounts excluded). The `students` table
 * requires a user, so a row with no account is counted, not stored.
 *
 * Re-importing is idempotent: an existing row is only touched when a provided
 * value differs, and a blank cell never clears a stored value.
 */
export async function applyRosterImport(
  tx: Transaction,
  organizationId: string,
  rows: readonly ValidImportRow[],
): Promise<ApplyImportResult> {
  const userIdByEmail = new Map<string, string>();
  const lowerEmail = sql<string>`lower(${users.email})`;
  for (const part of chunks(
    rows.map((row) => row.email),
    LOOKUP_CHUNK,
  )) {
    const found = await tx
      .select({ userId: users.userId, email: lowerEmail })
      .from(users)
      .where(and(isNull(users.deletedAt), inArray(lowerEmail, part)));
    for (const account of found) userIdByEmail.set(account.email, account.userId);
  }

  const existingByUserId = new Map<
    string,
    { studentId: string; program: string | null; graduationYear: number | null }
  >();
  for (const part of chunks([...userIdByEmail.values()], LOOKUP_CHUNK)) {
    const found = await tx
      .select({
        studentId: students.studentId,
        userId: students.userId,
        program: students.department,
        graduationYear: students.graduationYear,
      })
      .from(students)
      .where(and(eq(students.organizationId, organizationId), inArray(students.userId, part)));
    for (const entry of found) existingByUserId.set(entry.userId, entry);
  }

  const toInsert: (typeof students.$inferInsert)[] = [];
  const toUpdate: { studentId: string; program: string | null; graduationYear: number | null }[] =
    [];
  const result: ApplyImportResult = { created: 0, updated: 0, unchanged: 0, noPlatformAccount: 0 };

  for (const row of rows) {
    const userId = userIdByEmail.get(row.email);
    if (userId === undefined) {
      result.noPlatformAccount += 1;
      continue;
    }
    const current = existingByUserId.get(userId);
    if (!current) {
      toInsert.push({
        organizationId,
        userId,
        department: row.program ?? null,
        graduationYear: row.graduationYear ?? null,
      });
      continue;
    }
    const programChanged = row.program !== undefined && row.program !== current.program;
    const yearChanged =
      row.graduationYear !== undefined && row.graduationYear !== current.graduationYear;
    if (programChanged || yearChanged) {
      toUpdate.push({
        studentId: current.studentId,
        program: row.program ?? null,
        graduationYear: row.graduationYear ?? null,
      });
    } else {
      result.unchanged += 1;
    }
  }

  for (const part of chunks(toInsert, WRITE_CHUNK)) {
    // A concurrent import may have inserted the same (organization, user) pair
    // since the lookup above; the unique index decides and the loser counts it
    // as unchanged rather than failing the whole import.
    const inserted = await tx
      .insert(students)
      .values(part)
      .onConflictDoNothing({ target: [students.organizationId, students.userId] })
      .returning({ studentId: students.studentId });
    result.created += inserted.length;
    result.unchanged += part.length - inserted.length;
  }

  for (const part of chunks(toUpdate, WRITE_CHUNK)) {
    const values = sql.join(
      part.map(
        (entry) =>
          sql`(${entry.studentId}::uuid, ${entry.program}::varchar, ${entry.graduationYear}::int)`,
      ),
      sql`, `,
    );
    // NULL means "not provided": COALESCE keeps the stored value.
    await tx.execute(sql`
      update ${students} as s
      set department = coalesce(v.department, s.department),
          graduation_year = coalesce(v.graduation_year, s.graduation_year)
      from (values ${values}) as v(student_id, department, graduation_year)
      where s.student_id = v.student_id and s.organization_id = ${organizationId}::uuid
    `);
    result.updated += part.length;
  }

  return result;
}
