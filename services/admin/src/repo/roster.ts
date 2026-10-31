import {
  and,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  emptyApplicationStatusCounts,
  type ApplicationStatus,
  type RosterFilter,
  type RosterStudent,
  type StudentInsights,
} from '@atlas/types';
import { AppError, encodeCursor, parseTimeCursor } from '@atlas/utils';
import { toIsoTimestamp } from '../lib/timestamps.js';

const { students, users, organizationMembers, resumes, applications } = schema;

/** `%`, `_` and `\` are LIKE metacharacters; a search term is always a literal. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function decodeRosterCursor(cursor: string): { createdAt: string; id: string } {
  const parsed = parseTimeCursor(cursor);
  if (parsed === null) throw new AppError('VALIDATION_ERROR', 'Invalid cursor');
  return parsed;
}

interface RosterRow {
  studentId: string;
  userId: string;
  email: string;
  fullName: string;
  program: string | null;
  graduationYear: number | null;
  status: string;
  createdAt: string;
  /** Non-null when the student is also a member of the organization. */
  memberUserId: string | null;
}

function rosterSelect(db: Database) {
  return (
    db
      .select({
        studentId: students.studentId,
        userId: students.userId,
        email: users.email,
        fullName: users.fullName,
        program: students.department,
        graduationYear: students.graduationYear,
        status: students.currentStatus,
        createdAt: students.createdAt,
        memberUserId: organizationMembers.userId,
      })
      .from(students)
      // Soft-deleted accounts disappear from the roster entirely.
      .innerJoin(users, and(eq(users.userId, students.userId), isNull(users.deletedAt)))
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, students.organizationId),
          eq(organizationMembers.userId, students.userId),
        ),
      )
  );
}

function filterConditions(db: Database, filter: RosterFilter): SQL[] {
  const conditions: SQL[] = [];
  const sharing = isNotNull(organizationMembers.userId);

  if (filter.search) {
    const pattern = `%${escapeLike(filter.search)}%`;
    // A name is only searchable where it is also visible.
    const match = or(ilike(users.email, pattern), and(sharing, ilike(users.fullName, pattern)));
    if (match) conditions.push(match);
  }

  if (filter.has_resume !== undefined) {
    const anyResume = db
      .select({ one: sql`1` })
      .from(resumes)
      .where(eq(resumes.userId, students.userId));
    const match = and(sharing, filter.has_resume ? exists(anyResume) : notExists(anyResume));
    if (match) conditions.push(match);
  }

  if (filter.application_status !== undefined) {
    const withStatus = db
      .select({ one: sql`1` })
      .from(applications)
      .where(
        and(
          eq(applications.userId, students.userId),
          eq(applications.organizationId, students.organizationId),
          eq(applications.status, filter.application_status),
        ),
      );
    const match = and(sharing, exists(withStatus));
    if (match) conditions.push(match);
  }

  return conditions;
}

function emptyInsights(): StudentInsights {
  return {
    has_resume: false,
    latest_ats_score: null,
    applications_total: 0,
    applications_by_status: emptyApplicationStatusCounts(),
    last_application_activity_at: null,
  };
}

/**
 * Resume and application summaries for a page of students: two grouped
 * queries regardless of page size. `userIds` must already be restricted to
 * students with sharing enabled — this function does not check consent.
 *
 * Only applications made in this organization's context are counted
 * (`applications.organization_id`), the same attribution the applications
 * service uses for its org-scoped view.
 */
async function loadInsights(
  db: Database,
  organizationId: string,
  userIds: string[],
): Promise<Map<string, StudentInsights>> {
  const insights = new Map<string, StudentInsights>();
  if (userIds.length === 0) return insights;

  const [resumeRows, applicationRows] = await Promise.all([
    db
      .select({
        userId: resumes.userId,
        resumeCount: sql<number>`count(*)::int`,
        latestAtsScore: sql<
          number | null
        >`(array_agg(${resumes.atsScore} order by ${resumes.createdAt} desc, ${resumes.resumeId} desc) filter (where ${resumes.status} = 'parsed' and ${resumes.atsScore} is not null))[1]`,
      })
      .from(resumes)
      .where(inArray(resumes.userId, userIds))
      .groupBy(resumes.userId),
    db
      .select({
        userId: applications.userId,
        status: applications.status,
        count: sql<number>`count(*)::int`,
        lastActivityAt: sql<string | null>`max(${applications.lastEventAt})`,
      })
      .from(applications)
      .where(
        and(inArray(applications.userId, userIds), eq(applications.organizationId, organizationId)),
      )
      .groupBy(applications.userId, applications.status),
  ]);

  for (const userId of userIds) insights.set(userId, emptyInsights());

  for (const row of resumeRows) {
    const entry = insights.get(row.userId);
    if (!entry) continue;
    entry.has_resume = row.resumeCount > 0;
    entry.latest_ats_score =
      row.latestAtsScore === null ? null : Math.round(row.latestAtsScore * 10) / 10;
  }

  for (const row of applicationRows) {
    const entry = insights.get(row.userId);
    if (!entry) continue;
    entry.applications_by_status[row.status as ApplicationStatus] = row.count;
    entry.applications_total += row.count;
    const activity = row.lastActivityAt === null ? null : toIsoTimestamp(row.lastActivityAt);
    if (
      activity !== null &&
      (entry.last_application_activity_at === null || activity > entry.last_application_activity_at)
    ) {
      entry.last_application_activity_at = activity;
    }
  }

  return insights;
}

async function toRosterStudents(
  db: Database,
  organizationId: string,
  rows: RosterRow[],
): Promise<RosterStudent[]> {
  const sharingUserIds = rows.filter((row) => row.memberUserId !== null).map((row) => row.userId);
  const insights = await loadInsights(db, organizationId, sharingUserIds);

  return rows.map((row): RosterStudent => {
    const sharingEnabled = row.memberUserId !== null;
    return {
      student_id: row.studentId,
      email: row.email,
      full_name: sharingEnabled ? row.fullName : null,
      program: row.program,
      graduation_year: row.graduationYear,
      status: row.status,
      created_at: toIsoTimestamp(row.createdAt),
      sharing_enabled: sharingEnabled,
      insights: sharingEnabled ? (insights.get(row.userId) ?? emptyInsights()) : null,
    };
  });
}

export interface RosterPage {
  items: RosterStudent[];
  nextCursor: string | null;
}

/**
 * Newest roster entries first, keyset-paginated on (created_at, student_id).
 * `created_at` alone is not unique — one import stamps every row with the same
 * transaction timestamp — so the id breaks ties at the page boundary.
 */
export async function listRoster(
  db: Database,
  organizationId: string,
  filter: RosterFilter,
  page: { limit: number; cursor?: string | undefined },
): Promise<RosterPage> {
  const conditions: SQL[] = [
    eq(students.organizationId, organizationId),
    ...filterConditions(db, filter),
  ];

  if (page.cursor) {
    const after = decodeRosterCursor(page.cursor);
    const beforeCursor = or(
      lt(students.createdAt, after.createdAt),
      and(eq(students.createdAt, after.createdAt), lt(students.studentId, after.id)),
    );
    if (beforeCursor) conditions.push(beforeCursor);
  }

  const rows = await rosterSelect(db)
    .where(and(...conditions))
    .orderBy(desc(students.createdAt), desc(students.studentId))
    .limit(page.limit + 1);

  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const last = pageRows[pageRows.length - 1];

  return {
    items: await toRosterStudents(db, organizationId, pageRows),
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.studentId }) : null,
  };
}

/** One roster entry, or null when it is not on *this* organization's roster. */
export async function findRosterStudent(
  db: Database,
  organizationId: string,
  studentId: string,
): Promise<RosterStudent | null> {
  const [row] = await rosterSelect(db)
    .where(and(eq(students.organizationId, organizationId), eq(students.studentId, studentId)))
    .limit(1);
  if (!row) return null;
  const [student] = await toRosterStudents(db, organizationId, [row]);
  return student ?? null;
}
