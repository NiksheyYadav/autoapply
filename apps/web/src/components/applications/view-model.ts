import type { ApplicationJobSummary, ApplicationResponse, ApplicationStatus } from '@atlas/types';
import { safeExternalUrl } from './external-url';
import { formatServiceDate } from './timestamp';

/**
 * One application as the owner's list/detail endpoints return it. `job` is
 * `null` when the job (or its company) was removed and absent on views that
 * must not carry job context, so every consumer has to tolerate both.
 */
export type ApplicationItem = ApplicationResponse['application'];

/**
 * Notes the applications-service recognises. Keep in step with
 * services/applications/src/lib/transitions.ts (OPENED_APPLY_LINK_NOTE): only
 * this exact note turns a `draft -> draft` event into the "opened the employer
 * page" marker; anything else is rejected as a no-op status change.
 */
export const OPENED_APPLY_LINK_NOTE = 'opened_apply_link';
export const MARKED_SUBMITTED_NOTE = 'Candidate confirmed they applied on the employer site.';

/**
 * The same (job, resume) always maps to the same key, so a retry after a
 * dropped response, a double click, or a second tab can never create a second
 * application: the service answers a repeat of the same request with the
 * application it already made. A different resume for the same job gets a
 * different key and is refused by the service's one-application-per-job rule,
 * which the caller resolves by loading the existing application.
 */
export function buildApplicationIdempotencyKey(jobId: string, resumeId: string): string {
  return `atlas-web:start:${jobId}:${resumeId}`;
}

/** Lifecycle order, earliest first. `satisfies` makes a new backend status a compile error here. */
const STATUS_RANK = {
  draft: 0,
  queued: 1,
  submitting: 2,
  submitted: 3,
  acknowledged: 4,
  interviewing: 5,
  offer: 6,
  rejected: 7,
  withdrawn: 8,
  failed: 9,
} satisfies Record<ApplicationStatus, number>;

function rankOf(status: string): number {
  return (STATUS_RANK as Record<string, number>)[status] ?? Number.MAX_SAFE_INTEGER;
}

export interface StatusFilter {
  /** `'all'` or an application status. */
  value: string;
  label: string;
  count: number;
}

function capitalise(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' ');
}

/** "All" plus one entry per status that actually occurs, in lifecycle order — no empty filters to click. */
export function buildStatusFilters(items: readonly ApplicationItem[]): StatusFilter[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);

  const perStatus = [...counts.entries()]
    .sort(([a], [b]) => rankOf(a) - rankOf(b) || a.localeCompare(b))
    .map(([value, count]) => ({ value, label: capitalise(value), count }));
  return [{ value: 'all', label: 'All', count: items.length }, ...perStatus];
}

export function filterByStatus<T extends ApplicationItem>(items: readonly T[], filter: string): T[] {
  return filter === 'all' ? [...items] : items.filter((item) => item.status === filter);
}

export function findApplicationForJob<T extends ApplicationItem>(items: readonly T[], jobId: string): T | null {
  return items.find((item) => item.job_id === jobId) ?? null;
}

export interface ApplicationDisplay {
  title: string;
  /** Null when the job summary is missing: we don't invent an employer name. */
  company: string | null;
  location: string | null;
  /** In-app link back to the job page, or null when the job no longer exists. */
  jobHref: string | null;
  /** The job is gone or no longer accepting applications. */
  jobUnavailable: boolean;
  createdLabel: string;
  submittedLabel: string | null;
}

export interface DisplayOptions {
  locale?: string;
  timeZone?: string;
}

/** Everything the applications list renders for one row, tolerant of a null/absent `job`. */
export function toApplicationDisplay(item: ApplicationItem, options: DisplayOptions = {}): ApplicationDisplay {
  const job: ApplicationJobSummary | null = item.job ?? null;
  const dateOptions = { locale: options.locale, timeZone: options.timeZone };
  return {
    title: job?.title ?? 'Job no longer available',
    company: job?.company_name ?? null,
    location: job?.location ?? null,
    jobHref: job ? `/dashboard/jobs/${item.job_id}` : null,
    jobUnavailable: job === null || !job.is_active,
    createdLabel: formatServiceDate(item.created_at, { ...dateOptions, fallback: 'recently' }),
    submittedLabel: item.submitted_at ? formatServiceDate(item.submitted_at, { ...dateOptions, fallback: 'recently' }) : null,
  };
}

/**
 * Where a job's assisted-apply flow stands:
 * - `none`: no application yet.
 * - `draft`: tracked in Atlas, not yet reported as submitted.
 * - `tracked`: past draft (submitted or later), so there is nothing left to do here.
 */
export type ApplyStage = 'none' | 'draft' | 'tracked';

export function deriveApplyStage(application: ApplicationItem | null): ApplyStage {
  if (!application) return 'none';
  return application.status === 'draft' ? 'draft' : 'tracked';
}

/**
 * The employer link to offer, always run through {@link safeExternalUrl}. The
 * application's own job summary wins (the service already filtered it to
 * http(s)); the job record is the fallback before an application exists.
 */
export function resolveApplyUrl(application: ApplicationItem | null, jobApplyUrl: string | null | undefined): string | null {
  return safeExternalUrl(application?.job?.apply_url) ?? safeExternalUrl(jobApplyUrl);
}
