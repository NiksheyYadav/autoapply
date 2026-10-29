import type { AdminFunnelResponse, ApplicationStatus } from '@atlas/types';
import { APPLICATION_STATUSES } from './contracts';

// --- date range ---------------------------------------------------------------------

/** What the two `<input type="date">` fields hold: `YYYY-MM-DD` or empty. Dates are read as UTC days. */
export interface DateRangeInput {
  from: string;
  to: string;
}

export interface FunnelQuery {
  /** Inclusive start, ISO-8601 UTC. */
  from?: string;
  /** Exclusive end, ISO-8601 UTC. */
  to?: string;
}

export type RangeResult = { ok: true; query: FunnelQuery } | { ok: false; message: string };

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds at 00:00:00 UTC of a real calendar day, or null (`2026-02-30` is not a day). */
function utcDayStart(value: string): number | null {
  const match = DAY_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return time;
}

/**
 * Turns the date fields into the API's half-open `[from, to)` window. The
 * person picks inclusive days, so `to` is sent as the start of the *following*
 * UTC day: picking 1 Sep to 30 Sep covers all of September. An empty field
 * leaves that side open.
 */
export function toFunnelQuery(input: DateRangeInput): RangeResult {
  const query: FunnelQuery = {};
  let fromTime: number | null = null;
  let toTime: number | null = null;

  if (input.from !== '') {
    fromTime = utcDayStart(input.from);
    if (fromTime === null) return { ok: false, message: 'Enter the start date as a real calendar date.' };
    query.from = new Date(fromTime).toISOString();
  }
  if (input.to !== '') {
    toTime = utcDayStart(input.to);
    if (toTime === null) return { ok: false, message: 'Enter the end date as a real calendar date.' };
    query.to = new Date(toTime + DAY_MS).toISOString();
  }
  if (fromTime !== null && toTime !== null && fromTime > toTime) {
    return { ok: false, message: 'The start date must be on or before the end date.' };
  }
  return { ok: true, query };
}

export function funnelQueryString(query: FunnelQuery): string {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  return params.toString();
}

// --- stages -------------------------------------------------------------------------

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** `now`: roster membership as of this moment. `range`: activity inside the selected dates. */
  basis: 'now' | 'range';
  description: string;
}

/**
 * The API's counts as an ordered list, nothing derived. `count` is always the
 * API's number. Stages are read top to bottom as "how far along" but are not a
 * strict subset chain (a student can have applied without a resume on file), so
 * no conversion percentages are computed.
 */
export function buildFunnelStages(funnel: AdminFunnelResponse): FunnelStage[] {
  return [
    {
      key: 'roster',
      label: 'On the roster',
      count: funnel.roster.size,
      basis: 'now',
      description: 'Every roster entry, as of now.',
    },
    {
      key: 'signed_up',
      label: 'Signed up on Atlas',
      count: funnel.roster.signed_up,
      basis: 'now',
      description: 'Linked to a live Atlas account.',
    },
    {
      key: 'sharing',
      label: 'Also a member of this organization',
      count: funnel.roster.sharing_enabled,
      basis: 'now',
      description: 'Resume and application figures below cover only these students.',
    },
    {
      key: 'resume',
      label: 'Has a resume',
      count: funnel.resumes.students_with_resume,
      basis: 'range',
      description: 'Resumes uploaded in the selected dates (all time when no dates are set).',
    },
    {
      key: 'ats',
      label: 'Has a scored resume',
      count: funnel.resumes.students_with_ats_score,
      basis: 'range',
      description: 'A resume with an ATS score.',
    },
    {
      key: 'applied',
      label: 'Has applied to a job',
      count: funnel.applications.students_applied,
      basis: 'range',
      description: 'At least one application in the selected dates.',
    },
    {
      key: 'offer',
      label: 'Has an offer',
      count: funnel.offers.students,
      basis: 'range',
      description: 'At least one application at the offer stage.',
    },
  ];
}

/** Width of a bar, 0 to 100, as `count` out of `total`. Never NaN, never over 100. */
export function barPercent(count: number, total: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0 || count <= 0) return 0;
  return Math.min(100, (count / total) * 100);
}

export interface StatusRow {
  status: ApplicationStatus;
  count: number;
}

/** Application counts in lifecycle order; a status the API omitted reads as 0. */
export function statusRows(byStatus: Partial<Record<ApplicationStatus, number>>): StatusRow[] {
  return APPLICATION_STATUSES.map((status) => ({ status, count: byStatus[status] ?? 0 }));
}
