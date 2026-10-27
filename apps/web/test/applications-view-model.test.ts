import type { ApplicationJobSummary, ApplicationResponse } from '@atlas/types';
import { describe, expect, it } from 'vitest';
import {
  buildApplicationIdempotencyKey,
  buildStatusFilters,
  deriveApplyStage,
  filterByStatus,
  findApplicationForJob,
  OPENED_APPLY_LINK_NOTE,
  resolveApplyUrl,
  toApplicationDisplay,
  type ApplicationItem,
} from '../src/components/applications/view-model';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const RESUME_ID = '22222222-2222-4222-8222-222222222222';

const JOB: ApplicationJobSummary = {
  job_id: JOB_ID,
  title: 'Platform Engineer',
  company_id: '33333333-3333-4333-8333-333333333333',
  company_name: 'Acme Robotics',
  location: 'Berlin',
  remote_type: 'hybrid',
  employment_type: 'full_time',
  apply_url: 'https://boards.greenhouse.io/acme/jobs/1',
  is_active: true,
};

function application(overrides: Partial<ApplicationItem> = {}): ApplicationItem {
  return {
    application_id: '44444444-4444-4444-8444-444444444444',
    user_id: '55555555-5555-4555-8555-555555555555',
    job_id: JOB_ID,
    resume_id: RESUME_ID,
    organization_id: null,
    status: 'draft',
    mode: 'manual',
    idempotency_key: 'atlas-web:start:x',
    submitted_at: null,
    // The exact shape the applications service sends.
    last_event_at: '2026-10-27 12:59:21.123+00',
    failure_reason: null,
    created_at: '2026-10-27 12:59:21.123+00',
    job: JOB,
    ...overrides,
  };
}

const DISPLAY = { locale: 'en-US', timeZone: 'UTC' };

describe('buildApplicationIdempotencyKey', () => {
  it('is stable for the same job and resume, so a retry cannot create a second application', () => {
    expect(buildApplicationIdempotencyKey(JOB_ID, RESUME_ID)).toBe(buildApplicationIdempotencyKey(JOB_ID, RESUME_ID));
  });

  it('differs per job and per resume', () => {
    const base = buildApplicationIdempotencyKey(JOB_ID, RESUME_ID);
    expect(buildApplicationIdempotencyKey('99999999-9999-4999-8999-999999999999', RESUME_ID)).not.toBe(base);
    expect(buildApplicationIdempotencyKey(JOB_ID, '99999999-9999-4999-8999-999999999999')).not.toBe(base);
  });

  it('fits the service limits (8-200 characters)', () => {
    const key = buildApplicationIdempotencyKey(JOB_ID, RESUME_ID);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(200);
  });
});

describe('the opened-link marker note', () => {
  it('is the exact string applications-service recognises', () => {
    // services/applications/src/lib/transitions.ts: OPENED_APPLY_LINK_NOTE. A different
    // string would be rejected as a draft -> draft no-op.
    expect(OPENED_APPLY_LINK_NOTE).toBe('opened_apply_link');
  });
});

describe('toApplicationDisplay', () => {
  it('shows job title, company, location and a link back to the job', () => {
    expect(toApplicationDisplay(application(), DISPLAY)).toEqual({
      title: 'Platform Engineer',
      company: 'Acme Robotics',
      location: 'Berlin',
      jobHref: `/dashboard/jobs/${JOB_ID}`,
      jobUnavailable: false,
      createdLabel: 'Oct 27, 2026',
      submittedLabel: null,
    });
  });

  it('reads the Postgres-style created_at and submitted_at without throwing', () => {
    const display = toApplicationDisplay(
      application({ status: 'submitted', submitted_at: '2026-10-28 09:00:00.5+00' }),
      DISPLAY,
    );
    expect(display.createdLabel).toBe('Oct 27, 2026');
    expect(display.submittedLabel).toBe('Oct 28, 2026');
  });

  it('degrades gracefully when job is null (job or company deleted)', () => {
    const display = toApplicationDisplay(application({ job: null }), DISPLAY);
    expect(display.title).toBe('Job no longer available');
    expect(display.company).toBeNull();
    expect(display.location).toBeNull();
    expect(display.jobHref).toBeNull();
    expect(display.jobUnavailable).toBe(true);
  });

  it('degrades gracefully when job is absent (views that carry no job context)', () => {
    const { job: _job, ...withoutJob } = application();
    const display = toApplicationDisplay(withoutJob, DISPLAY);
    expect(display.title).toBe('Job no longer available');
    expect(display.jobHref).toBeNull();
  });

  it('flags a job that still exists but is closed', () => {
    const display = toApplicationDisplay(application({ job: { ...JOB, is_active: false } }), DISPLAY);
    expect(display.jobUnavailable).toBe(true);
    expect(display.jobHref).toBe(`/dashboard/jobs/${JOB_ID}`);
    expect(display.company).toBe('Acme Robotics');
  });

  it('falls back instead of printing "Invalid Date" for an unreadable timestamp', () => {
    const display = toApplicationDisplay(application({ created_at: 'not a date' }), DISPLAY);
    expect(display.createdLabel).toBe('recently');
  });
});

describe('status filters', () => {
  const items = [
    application({ application_id: 'a', status: 'interviewing' }),
    application({ application_id: 'b', status: 'draft' }),
    application({ application_id: 'c', status: 'submitted' }),
    application({ application_id: 'd', status: 'draft' }),
    application({ application_id: 'e', status: 'rejected' }),
  ];

  it('offers All plus only the statuses present, in lifecycle order, with counts', () => {
    expect(buildStatusFilters(items)).toEqual([
      { value: 'all', label: 'All', count: 5 },
      { value: 'draft', label: 'Draft', count: 2 },
      { value: 'submitted', label: 'Submitted', count: 1 },
      { value: 'interviewing', label: 'Interviewing', count: 1 },
      { value: 'rejected', label: 'Rejected', count: 1 },
    ]);
  });

  it('is just "All (0)" for an empty list', () => {
    expect(buildStatusFilters([])).toEqual([{ value: 'all', label: 'All', count: 0 }]);
  });

  it('places a status the client does not know about last instead of dropping it', () => {
    const odd = application({ status: 'on_hold' as ApplicationItem['status'] });
    const filters = buildStatusFilters([application(), odd]);
    expect(filters.map((filter) => filter.value)).toEqual(['all', 'draft', 'on_hold']);
    expect(filters[2]?.label).toBe('On hold');
  });

  it('filters by status and returns everything for "all"', () => {
    expect(filterByStatus(items, 'draft').map((item) => item.application_id)).toEqual(['b', 'd']);
    expect(filterByStatus(items, 'all')).toHaveLength(5);
    expect(filterByStatus(items, 'offer')).toEqual([]);
  });

  it('does not mutate its input', () => {
    const copy = [...items];
    filterByStatus(items, 'all').reverse();
    expect(items).toEqual(copy);
  });
});

describe('findApplicationForJob', () => {
  it('finds the application for a job', () => {
    const mine = application({ application_id: 'mine' });
    const other = application({ application_id: 'other', job_id: '99999999-9999-4999-8999-999999999999' });
    expect(findApplicationForJob([other, mine], JOB_ID)?.application_id).toBe('mine');
  });

  it('is null when there is none', () => {
    expect(findApplicationForJob([], JOB_ID)).toBeNull();
  });
});

describe('deriveApplyStage', () => {
  it('is "none" before an application exists', () => {
    expect(deriveApplyStage(null)).toBe('none');
  });

  it('is "draft" while the application is still a draft', () => {
    expect(deriveApplyStage(application({ status: 'draft' }))).toBe('draft');
  });

  it.each(['submitted', 'acknowledged', 'interviewing', 'offer', 'rejected', 'withdrawn', 'queued', 'failed'] as const)(
    'is "tracked" once the status is %s, so the draft actions go away',
    (status) => {
      expect(deriveApplyStage(application({ status }))).toBe('tracked');
    },
  );
});

describe('resolveApplyUrl', () => {
  it("prefers the application's own job summary", () => {
    expect(resolveApplyUrl(application(), 'https://other.example/apply')).toBe('https://boards.greenhouse.io/acme/jobs/1');
  });

  it('falls back to the job record before an application exists', () => {
    expect(resolveApplyUrl(null, 'https://jobs.example.com/apply')).toBe('https://jobs.example.com/apply');
  });

  it('falls back when the summary has a null or absent job', () => {
    expect(resolveApplyUrl(application({ job: null }), 'https://jobs.example.com/apply')).toBe('https://jobs.example.com/apply');
  });

  it('never returns an unsafe URL, even from the service summary', () => {
    const unsafe = application({ job: { ...JOB, apply_url: 'javascript:alert(1)' } });
    expect(resolveApplyUrl(unsafe, 'data:text/html,hi')).toBeNull();
    expect(resolveApplyUrl(unsafe, 'https://jobs.example.com/apply')).toBe('https://jobs.example.com/apply');
  });

  it('is null when there is no apply link anywhere', () => {
    expect(resolveApplyUrl(null, null)).toBeNull();
    expect(resolveApplyUrl(application({ job: { ...JOB, apply_url: null } }), undefined)).toBeNull();
  });
});

// Compile-time check that the owner view the service returns is assignable to what the UI consumes.
const _shape: ApplicationResponse = { application: application() };
void _shape;
