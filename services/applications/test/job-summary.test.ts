import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applicationJobSummarySchema } from '@atlas/types';
import { toJobSummary, type JobSummaryRow } from '../src/repo/lookups.js';
import { toApplicationWithJob, type ApplicationRow } from '../src/repo/applications.js';

function fullRow(overrides: Partial<JobSummaryRow> = {}): JobSummaryRow {
  return {
    jobId: randomUUID(),
    title: 'Backend Engineer',
    companyId: randomUUID(),
    companyName: 'Acme Corp',
    location: 'Berlin',
    remoteType: 'hybrid',
    employmentType: 'full_time',
    applyUrl: 'https://careers.acme.example/jobs/1',
    isActive: true,
    ...overrides,
  };
}

const NO_JOB: JobSummaryRow = {
  jobId: null,
  title: null,
  companyId: null,
  companyName: null,
  location: null,
  remoteType: null,
  employmentType: null,
  applyUrl: null,
  isActive: null,
};

describe('toJobSummary', () => {
  it('maps a joined row to the API summary shape', () => {
    const row = fullRow();
    const summary = toJobSummary(row);

    expect(summary).toEqual({
      job_id: row.jobId,
      title: 'Backend Engineer',
      company_id: row.companyId,
      company_name: 'Acme Corp',
      location: 'Berlin',
      remote_type: 'hybrid',
      employment_type: 'full_time',
      apply_url: 'https://careers.acme.example/jobs/1',
      is_active: true,
    });
    expect(applicationJobSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('keeps a job without a location or apply link', () => {
    const summary = toJobSummary(fullRow({ location: null, applyUrl: null }));
    expect(summary).toMatchObject({ location: null, apply_url: null });
  });

  it('serves only http(s) apply links', () => {
    expect(toJobSummary(fullRow({ applyUrl: 'javascript:alert(1)' }))?.apply_url).toBeNull();
    expect(toJobSummary(fullRow({ applyUrl: 'data:text/html,hi' }))?.apply_url).toBeNull();
    expect(toJobSummary(fullRow({ applyUrl: 'not a url' }))?.apply_url).toBeNull();
  });

  it('keeps inactive jobs visible, flagged is_active=false', () => {
    expect(toJobSummary(fullRow({ isActive: false }))?.is_active).toBe(false);
  });

  it('is null when the job row is gone (every joined column null)', () => {
    expect(toJobSummary(NO_JOB)).toBeNull();
  });

  it('is null when the company row is gone (job present, company columns null)', () => {
    expect(toJobSummary(fullRow({ companyName: null }))).toBeNull();
  });
});

describe('toApplicationWithJob', () => {
  const row: ApplicationRow = {
    applicationId: randomUUID(),
    userId: randomUUID(),
    jobId: randomUUID(),
    resumeId: randomUUID(),
    organizationId: null,
    status: 'draft',
    mode: 'manual',
    idempotencyKey: 'idem-key-unit',
    coverLetter: null,
    submittedAt: null,
    lastEventAt: new Date().toISOString(),
    failureReason: null,
    createdAt: new Date().toISOString(),
  };

  it('adds job additively and leaves every existing field untouched', () => {
    const job = toJobSummary(fullRow());
    const view = toApplicationWithJob(row, job);
    const { job: attached, ...rest } = view;

    expect(attached).toEqual(job);
    expect(rest).toEqual({
      application_id: row.applicationId,
      user_id: row.userId,
      job_id: row.jobId,
      resume_id: row.resumeId,
      organization_id: null,
      status: 'draft',
      mode: 'manual',
      idempotency_key: 'idem-key-unit',
      submitted_at: null,
      last_event_at: row.lastEventAt,
      failure_reason: null,
      created_at: row.createdAt,
    });
  });

  it('carries an explicit null (not a missing key) when the job is gone', () => {
    const view = toApplicationWithJob(row, null);
    expect(Object.hasOwn(view, 'job')).toBe(true);
    expect(view.job).toBeNull();
  });
});
