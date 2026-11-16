import { APPLICATION_STATUSES, type RosterStudent } from '@atlas/types';
import { toCsv, type CsvCell } from './csv-write.js';

/**
 * Export columns. Identity first, then the sharing-gated summary. Per-status
 * counts use the real application status enum, one column each.
 */
export const EXPORT_COLUMNS = [
  'email',
  'full_name',
  'program',
  'graduation_year',
  'status',
  'sharing_enabled',
  'has_resume',
  'latest_ats_score',
  'applications_total',
  ...APPLICATION_STATUSES.map((status) => `applications_${status}`),
] as const;

function exportRow(student: RosterStudent): CsvCell[] {
  const insights = student.insights;
  return [
    student.email,
    student.full_name,
    student.program,
    student.graduation_year,
    student.status,
    student.sharing_enabled,
    // Empty (not false / 0) where sharing is off: unknown is not the same as none.
    insights?.has_resume,
    insights?.latest_ats_score,
    insights?.applications_total,
    ...APPLICATION_STATUSES.map((status) => insights?.applications_by_status[status]),
  ];
}

/** Renders roster entries as a CSV document. Every string cell is formula-neutralized by {@link toCsv}. */
export function rosterToCsv(students: readonly RosterStudent[], options: { bom: boolean }): string {
  return toCsv(EXPORT_COLUMNS, students.map(exportRow), { bom: options.bom });
}
