import { describe, expect, it } from 'vitest';
import { accountExportSchema, ACCOUNT_EXPORT_VERSION, type AccountExport, type ExportApplication } from '@atlas/types';
import {
  exportByteLength,
  fitExportToBudget,
  recordTruncation,
  serializeExport,
} from '../src/lib/export-budget.js';

const ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-27T12:00:00.000Z';

function application(index: number, eventCount: number, noteSize = 10): ExportApplication {
  return {
    application_id: ID,
    job: { job_id: ID, title: `Job ${index}`, company_name: 'Co', location: null },
    resume_id: null,
    organization_id: null,
    status: 'submitted',
    mode: 'manual',
    cover_letter: null,
    submitted_at: null,
    last_event_at: NOW,
    failure_reason: null,
    created_at: NOW,
    events: Array.from({ length: eventCount }, () => ({
      event_id: ID,
      from_status: null,
      to_status: 'submitted',
      note: 'n'.repeat(noteSize),
      metadata: {},
      created_at: NOW,
    })),
  };
}

function documentWith(parts: Partial<AccountExport> = {}): AccountExport {
  return {
    export_version: ACCOUNT_EXPORT_VERSION,
    generated_at: NOW,
    user: {
      user_id: ID,
      email: 'someone@example.test',
      full_name: 'Some One',
      auth_provider: 'password',
      email_verified: true,
      mfa_enabled: false,
      primary_resume_id: null,
      last_login_at: null,
      created_at: NOW,
      updated_at: NOW,
    },
    organization_memberships: [],
    student_records: [],
    resumes: [],
    applications: [],
    messages: [],
    job_scores: [],
    activity_events: [],
    connected_accounts: [],
    truncated: [],
    notes: [],
    ...parts,
  };
}

const score = (index: number) => ({
  job: { job_id: ID, title: `Job ${index}`, company_name: 'Co', location: null },
  score: 1 - index / 1000,
  reasons: ['r'.repeat(40)],
  skill_gaps: [],
  model_version: 'm',
  scored_at: NOW,
});

const resume = (textSize: number) => ({
  resume_id: ID,
  original_filename: 'cv.pdf',
  content_type: 'application/pdf',
  byte_size: 1,
  status: 'parsed' as const,
  parsed_text: 't'.repeat(textSize),
  parsed_profile: null,
  ats_score: null,
  ats_report: null,
  failure_reason: null,
  parsed_at: null,
  created_at: NOW,
  updated_at: NOW,
});

describe('fitExportToBudget', () => {
  it('leaves a document that already fits exactly as it was, with nothing recorded', () => {
    const doc = documentWith({ job_scores: [score(0), score(1)] });
    const before = serializeExport(doc);

    const out = fitExportToBudget(doc, 1_000_000);

    expect(out).toBe(before);
    expect(doc.truncated).toEqual([]);
    expect(doc.job_scores).toHaveLength(2);
  });

  it('halves the heaviest section first and keeps the front of the list (the most relevant rows)', () => {
    const doc = documentWith({
      job_scores: Array.from({ length: 200 }, (_, index) => score(index)),
      resumes: [resume(100)],
    });
    const budget = exportByteLength(doc) - 5_000;

    const out = fitExportToBudget(doc, budget);

    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(budget);
    expect(doc.job_scores.length).toBeLessThan(200);
    expect(doc.job_scores.length).toBeGreaterThan(0);
    expect(doc.job_scores[0]!.job.title).toBe('Job 0');
    expect(doc.resumes).toHaveLength(1);
    expect(doc.truncated).toEqual([{ section: 'job_scores', returned: doc.job_scores.length, reason: 'size_limit' }]);
  });

  it('returns the exact text it measured, and that text parses against the published schema', () => {
    const doc = documentWith({
      resumes: Array.from({ length: 8 }, () => resume(2_000)),
      job_scores: Array.from({ length: 50 }, (_, index) => score(index)),
    });

    const out = fitExportToBudget(doc, 6_000);

    expect(out).toBe(serializeExport(doc));
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(6_000);
    expect(accountExportSchema.parse(JSON.parse(out)).truncated.length).toBeGreaterThan(0);
  });

  it('counts bytes, not characters', () => {
    const doc = documentWith({ resumes: [resume(10)] });
    doc.resumes[0]!.parsed_text = 'é'.repeat(3_000);
    const asCharacters = serializeExport(doc).length;
    expect(exportByteLength(doc)).toBeGreaterThan(asCharacters);

    fitExportToBudget(doc, asCharacters + 100);

    // It fit by character count but not by byte count, so it must have been cut.
    expect(doc.truncated).toEqual([{ section: 'resumes', returned: 0, reason: 'size_limit' }]);
  });

  it('trims application events across all applications together, from the end', () => {
    const doc = documentWith({
      applications: [application(0, 40, 200), application(1, 40, 200)],
    });
    const total = () => doc.applications.reduce((sum, app) => sum + app.events.length, 0);
    const budget = Math.floor(exportByteLength(doc) * 0.6);

    fitExportToBudget(doc, budget);

    expect(exportByteLength(doc)).toBeLessThanOrEqual(budget);
    expect(total()).toBeLessThan(80);
    // Both applications are still listed; the cut came off the tail (the second application's events go first).
    expect(doc.applications).toHaveLength(2);
    expect(doc.applications[0]!.events.length).toBeGreaterThanOrEqual(doc.applications[1]!.events.length);
    expect(doc.truncated.map((entry) => entry.section)).toEqual(['application_events']);
    expect(doc.truncated[0]!.returned).toBe(total());
  });

  it('never cuts the account, memberships, roster or connections, and stops when nothing cuttable is left', () => {
    const doc = documentWith({ resumes: [resume(50_000)], job_scores: [score(0)] });

    const out = fitExportToBudget(doc, 10);

    expect(doc.resumes).toEqual([]);
    expect(doc.job_scores).toEqual([]);
    expect(doc.user.user_id).toBe(ID);
    // Over budget even when empty: it returns what it has rather than looping or throwing.
    expect(Buffer.byteLength(out)).toBeGreaterThan(10);
  });
});

describe('recordTruncation', () => {
  it('keeps one entry per section and updates it on a later cut', () => {
    const truncated: AccountExport['truncated'] = [];

    recordTruncation(truncated, { section: 'messages', returned: 100, reason: 'row_limit' });
    recordTruncation(truncated, { section: 'job_scores', returned: 5, reason: 'row_limit' });
    recordTruncation(truncated, { section: 'messages', returned: 50, reason: 'size_limit' });

    expect(truncated).toEqual([
      { section: 'messages', returned: 50, reason: 'size_limit' },
      { section: 'job_scores', returned: 5, reason: 'row_limit' },
    ]);
  });
});
