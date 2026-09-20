import { and, eq, gte, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';

export interface EventTypeCount {
  eventType: string;
  count: number;
}

export async function summarizeForOrganization(
  db: Database,
  organizationId: string,
  since: string,
): Promise<EventTypeCount[]> {
  const rows = await db
    .select({ eventType: schema.analyticsEvents.eventType, count: sql<number>`count(*)::int` })
    .from(schema.analyticsEvents)
    .where(and(eq(schema.analyticsEvents.organizationId, organizationId), gte(schema.analyticsEvents.timestamp, since)))
    .groupBy(schema.analyticsEvents.eventType);
  return rows;
}
