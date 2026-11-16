import { describe, expect, it } from 'vitest';
import { exportStudentsQuerySchema, listAdminStudentsQuerySchema } from '@atlas/types';
import {
  EMPTY_ROSTER_FILTER,
  MAX_SEARCH_LENGTH,
  PAGE_SIZES,
  filterParams,
  hasActiveFilters,
  isApplicationStatus,
  isPageSize,
  normalizeSearch,
  rosterQuery,
} from '../src/lib/roster-query';

describe('rosterQuery', () => {
  it('sends only the limit when nothing is filtered', () => {
    expect(rosterQuery(EMPTY_ROSTER_FILTER, { limit: 25, cursor: null })).toBe('limit=25');
  });

  it('adds the cursor only after the first page', () => {
    expect(rosterQuery(EMPTY_ROSTER_FILTER, { limit: 50, cursor: 'abc' })).toBe('limit=50&cursor=abc');
  });

  it('maps the filters to the API’s parameter names and values', () => {
    const query = rosterQuery(
      { search: ' jane ', hasResume: 'no', applicationStatus: 'interviewing' },
      { limit: 25, cursor: null },
    );
    const params = new URLSearchParams(query);
    expect(params.get('search')).toBe('jane');
    expect(params.get('has_resume')).toBe('false');
    expect(params.get('application_status')).toBe('interviewing');
  });

  it('encodes search terms such as email addresses safely', () => {
    const query = rosterQuery({ ...EMPTY_ROSTER_FILTER, search: 'a+b@uni.edu&x=1' }, { limit: 25, cursor: null });
    expect(new URLSearchParams(query).get('search')).toBe('a+b@uni.edu&x=1');
    expect(new URLSearchParams(query).get('x')).toBeNull();
  });

  it('produces a query the API’s own schema accepts, for every filter combination', () => {
    for (const hasResume of ['any', 'yes', 'no'] as const) {
      for (const applicationStatus of ['', 'offer', 'draft'] as const) {
        for (const search of ['', 'x', 'jane@uni.edu']) {
          const query = rosterQuery({ search, hasResume, applicationStatus }, { limit: 100, cursor: 'c1' });
          const parsed = listAdminStudentsQuerySchema.safeParse(Object.fromEntries(new URLSearchParams(query)));
          expect(parsed.success, query).toBe(true);
        }
      }
    }
  });

  it('caps the search at the length the API accepts', () => {
    const long = 'x'.repeat(MAX_SEARCH_LENGTH + 50);
    expect(normalizeSearch(long)).toHaveLength(MAX_SEARCH_LENGTH);
    const parsed = listAdminStudentsQuerySchema.safeParse(
      Object.fromEntries(new URLSearchParams(rosterQuery({ ...EMPTY_ROSTER_FILTER, search: long }, { limit: 25, cursor: null }))),
    );
    expect(parsed.success).toBe(true);
  });
});

describe('filterParams (used by the export)', () => {
  it('is empty for an unfiltered roster, so an export is the whole roster', () => {
    expect(filterParams(EMPTY_ROSTER_FILTER).toString()).toBe('');
  });

  it('matches the export endpoint’s schema', () => {
    const params = filterParams({ search: 'jane', hasResume: 'yes', applicationStatus: 'submitted' });
    const parsed = exportStudentsQuerySchema.parse(Object.fromEntries(params));
    expect(parsed).toMatchObject({ search: 'jane', has_resume: true, application_status: 'submitted', bom: true });
  });

  it('does not put pagination in an export', () => {
    expect(filterParams(EMPTY_ROSTER_FILTER).has('limit')).toBe(false);
    expect(filterParams(EMPTY_ROSTER_FILTER).has('cursor')).toBe(false);
  });
});

describe('filter helpers', () => {
  it('treats whitespace-only search as no filter', () => {
    expect(hasActiveFilters({ ...EMPTY_ROSTER_FILTER, search: '   ' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_ROSTER_FILTER, search: 'a' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_ROSTER_FILTER, hasResume: 'yes' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_ROSTER_FILTER, applicationStatus: 'offer' })).toBe(true);
    expect(hasActiveFilters(EMPTY_ROSTER_FILTER)).toBe(false);
  });

  it('validates select values coming from the DOM', () => {
    expect(isApplicationStatus('offer')).toBe(true);
    expect(isApplicationStatus('hired')).toBe(false);
    expect(isApplicationStatus('')).toBe(false);
    expect(PAGE_SIZES.every((size) => isPageSize(size))).toBe(true);
    expect(isPageSize(30)).toBe(false);
  });

  it('only offers page sizes within the API’s limit of 100', () => {
    expect(Math.max(...PAGE_SIZES)).toBeLessThanOrEqual(100);
  });
});
