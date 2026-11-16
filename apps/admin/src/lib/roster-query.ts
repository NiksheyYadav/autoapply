import type { ApplicationStatus } from '@atlas/types';
import { APPLICATION_STATUSES } from './contracts';

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

/** The API trims and rejects search terms over 200 characters. */
export const MAX_SEARCH_LENGTH = 200;

export type HasResumeFilter = 'any' | 'yes' | 'no';

export interface RosterFilterState {
  search: string;
  hasResume: HasResumeFilter;
  /** Empty string = no filter. */
  applicationStatus: ApplicationStatus | '';
}

export const EMPTY_ROSTER_FILTER: RosterFilterState = {
  search: '',
  hasResume: 'any',
  applicationStatus: '',
};

export function isApplicationStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value);
}

export function isPageSize(value: number): value is PageSize {
  return (PAGE_SIZES as readonly number[]).includes(value);
}

export function normalizeSearch(search: string): string {
  return search.trim().slice(0, MAX_SEARCH_LENGTH);
}

export function hasActiveFilters(filter: RosterFilterState): boolean {
  return (
    normalizeSearch(filter.search) !== '' ||
    filter.hasResume !== 'any' ||
    filter.applicationStatus !== ''
  );
}

/** The filter part of the roster and export queries. Unset filters are omitted, not sent empty. */
export function filterParams(filter: RosterFilterState): URLSearchParams {
  const params = new URLSearchParams();
  const search = normalizeSearch(filter.search);
  if (search !== '') params.set('search', search);
  if (filter.hasResume !== 'any') params.set('has_resume', filter.hasResume === 'yes' ? 'true' : 'false');
  if (filter.applicationStatus !== '') params.set('application_status', filter.applicationStatus);
  return params;
}

export function rosterQuery(
  filter: RosterFilterState,
  page: { limit: number; cursor: string | null },
): string {
  const params = filterParams(filter);
  params.set('limit', String(page.limit));
  if (page.cursor !== null) params.set('cursor', page.cursor);
  return params.toString();
}
