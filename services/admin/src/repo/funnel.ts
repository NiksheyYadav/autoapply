import { and, desc, eq, gte, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  emptyApplicationStatusCounts,
  type AdminFunnelResponse,
  type ApplicationStatus,
} from '@atlas/types';

const { students, users, organizationMembers, resumes, applications } = schema;

export interface FunnelRange {
  /** Inclusive lower bound (ISO-8601), or undefined for no lower bound. */
  from?: string | undefined;
  /** Exclusive upper bound (ISO-8601), or undefined for no upper bound. */
  to?: string | undefined;
}

type FunnelCounts = Omit<AdminFunnelResponse, 'organization_id' | 'range' | 'generated_at'>;

/**
 * Aggregate funnel for one organization: a fixed number of grouped queries, no
 * per-student work. Everything past the roster counts is restricted to
 * students with sharing enabled (members of the organization, live accounts),
 * and application counts to applications attributed to this organization.
 */
export async function computeFunnel(
  db: Database,
  organizationId: string,
  range: FunnelRange,
): Promise<FunnelCounts> {
  const inRange = (column: Parameters<typeof gte>[0]): SQL[] => {
    const bounds: SQL[] = [];
    if (range.from) bounds.push(gte(column, range.from));
    if (range.to) bounds.push(lt(column, range.to));
    return bounds;
  };

  // The students whose own activity may be counted.
  const sharing = db
    .select({ userId: students.userId })
    .from(students)
    .innerJoin(users, and(eq(users.userId, students.userId), isNull(users.deletedAt)))
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, students.organizationId),
        eq(organizationMembers.userId, students.userId),
      ),
    )
    .where(eq(students.organizationId, organizationId))
    .as('sharing');

  // Each student's most recent scored resume (one row per student).
  const latestScored = db
    .selectDistinctOn([resumes.userId], { userId: resumes.userId, atsScore: resumes.atsScore })
    .from(resumes)
    .innerJoin(sharing, eq(sharing.userId, resumes.userId))
    .where(
      and(eq(resumes.status, 'parsed'), isNotNull(resumes.atsScore), ...inRange(resumes.createdAt)),
    )
    .orderBy(resumes.userId, desc(resumes.createdAt))
    .as('latest_scored');

  const applicationScope = (): SQL[] => [
    eq(applications.organizationId, organizationId),
    ...inRange(applications.createdAt),
  ];

  const [rosterRows, resumeRows, scoreRows, statusRows, appliedRows] = await Promise.all([
    db
      .select({
        size: sql<number>`count(*)::int`,
        signedUp: sql<number>`(count(*) filter (where ${users.userId} is not null))::int`,
        sharingEnabled: sql<number>`(count(*) filter (where ${users.userId} is not null and ${organizationMembers.userId} is not null))::int`,
      })
      .from(students)
      .leftJoin(users, and(eq(users.userId, students.userId), isNull(users.deletedAt)))
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, students.organizationId),
          eq(organizationMembers.userId, students.userId),
        ),
      )
      .where(eq(students.organizationId, organizationId)),

    db
      .select({ withResume: sql<number>`count(distinct ${resumes.userId})::int` })
      .from(resumes)
      .innerJoin(sharing, eq(sharing.userId, resumes.userId))
      .where(and(...inRange(resumes.createdAt))),

    db
      .select({
        scored: sql<number>`count(*)::int`,
        average: sql<number | null>`round(avg(${latestScored.atsScore})::numeric, 1)::float8`,
      })
      .from(latestScored),

    db
      .select({
        status: applications.status,
        count: sql<number>`count(*)::int`,
        students: sql<number>`count(distinct ${applications.userId})::int`,
      })
      .from(applications)
      .innerJoin(sharing, eq(sharing.userId, applications.userId))
      .where(and(...applicationScope()))
      .groupBy(applications.status),

    db
      .select({ students: sql<number>`count(distinct ${applications.userId})::int` })
      .from(applications)
      .innerJoin(sharing, eq(sharing.userId, applications.userId))
      .where(and(...applicationScope())),
  ]);

  const byStatus = emptyApplicationStatusCounts();
  const studentsByStatus = new Map<ApplicationStatus, number>();
  let total = 0;
  for (const row of statusRows) {
    byStatus[row.status] = row.count;
    studentsByStatus.set(row.status, row.students);
    total += row.count;
  }

  const roster = rosterRows[0];
  return {
    roster: {
      size: roster?.size ?? 0,
      signed_up: roster?.signedUp ?? 0,
      sharing_enabled: roster?.sharingEnabled ?? 0,
    },
    resumes: {
      students_with_resume: resumeRows[0]?.withResume ?? 0,
      students_with_ats_score: scoreRows[0]?.scored ?? 0,
      avg_ats_score: scoreRows[0]?.average ?? null,
    },
    applications: {
      total,
      students_applied: appliedRows[0]?.students ?? 0,
      by_status: byStatus,
    },
    offers: {
      applications: byStatus.offer,
      students: studentsByStatus.get('offer') ?? 0,
    },
  };
}
