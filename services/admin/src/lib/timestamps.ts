/**
 * drizzle's postgres-js driver returns timestamptz as Postgres prints it
 * (`2026-10-27 12:34:56.123456+00`). The API contract is ISO-8601 UTC
 * (`isoTimestampSchema`), so normalize at the boundary.
 */
export function toIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('toIsoTimestamp: not a timestamp');
  }
  return parsed.toISOString();
}
