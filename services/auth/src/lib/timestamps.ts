/**
 * drizzle's postgres-js driver returns timestamptz as Postgres prints it
 * (`2026-10-27 12:34:56.123456+00`). The export contract is ISO-8601 UTC
 * (`isoTimestampSchema`), so normalize at the boundary.
 */
export function toIso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('toIso: not a timestamp');
  }
  return parsed.toISOString();
}

export function toIsoOrNull(value: string | null): string | null {
  return value === null ? null : toIso(value);
}
