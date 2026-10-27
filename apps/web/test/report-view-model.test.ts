import type { Resume, ResumeOptimizationReport } from '@atlas/types';
import { describe, expect, it } from 'vitest';
import {
  defaultResumeId,
  FALLBACK_TRUTHFULNESS_NOTE,
  keywordBand,
  pickParsedResumes,
  resumeAvailability,
  resumeOptionLabel,
  resumeStateHint,
  toReportViewModel,
} from '../src/components/resume-check/report-view-model';

function resume(overrides: Partial<Resume> & Pick<Resume, 'resume_id'>): Resume {
  return {
    user_id: '55555555-5555-4555-8555-555555555555',
    storage_url: 'resumes/x',
    original_filename: `${overrides.resume_id}.pdf`,
    content_type: 'application/pdf',
    byte_size: 1000,
    status: 'parsed',
    parsed_text: 'text',
    parsed_profile: null,
    ats_score: 80,
    embedding_id: null,
    failure_reason: null,
    created_at: '2026-10-01 10:00:00+00',
    updated_at: '2026-10-01 10:00:00+00',
    ...overrides,
  };
}

describe('pickParsedResumes / defaultResumeId', () => {
  const older = resume({ resume_id: 'older', created_at: '2026-09-01 08:00:00.123456+00' });
  const newest = resume({ resume_id: 'newest', created_at: '2026-10-20 08:00:00+00' });
  const middle = resume({ resume_id: 'middle', created_at: '2026-10-05 08:00:00+00' });
  const failed = resume({ resume_id: 'failed', status: 'failed', created_at: '2026-10-25 08:00:00+00' });
  const processing = resume({ resume_id: 'processing', status: 'processing', created_at: '2026-10-26 08:00:00+00' });

  it('keeps only parsed resumes, newest first, regardless of the order the API returned', () => {
    const ids = pickParsedResumes([older, failed, newest, processing, middle]).map((r) => r.resume_id);
    expect(ids).toEqual(['newest', 'middle', 'older']);
  });

  it('defaults to the most recent parsed resume, ignoring a newer one that failed or is still processing', () => {
    expect(defaultResumeId([failed, processing, older, newest])).toBe('newest');
  });

  it('has no default when nothing is parsed', () => {
    expect(defaultResumeId([failed, processing])).toBeNull();
    expect(defaultResumeId([])).toBeNull();
  });

  it('keeps API order for resumes whose dates cannot be read, after the dated ones', () => {
    const a = resume({ resume_id: 'a', created_at: 'garbage' });
    const b = resume({ resume_id: 'b', created_at: 'garbage' });
    const dated = resume({ resume_id: 'dated', created_at: '2026-01-01 00:00:00+00' });
    expect(pickParsedResumes([a, b, dated]).map((r) => r.resume_id)).toEqual(['dated', 'a', 'b']);
  });

  it('does not mutate the list it was given', () => {
    const input = [older, newest];
    pickParsedResumes(input);
    expect(input.map((r) => r.resume_id)).toEqual(['older', 'newest']);
  });
});

describe('resumeAvailability', () => {
  it('tells the empty, still-processing, failed and ready cases apart', () => {
    expect(resumeAvailability([])).toBe('none');
    expect(resumeAvailability([resume({ resume_id: 'p', status: 'pending' })])).toBe('processing');
    expect(resumeAvailability([resume({ resume_id: 'p', status: 'processing' })])).toBe('processing');
    expect(resumeAvailability([resume({ resume_id: 'f', status: 'failed' })])).toBe('failed');
    expect(resumeAvailability([resume({ resume_id: 'f', status: 'failed' }), resume({ resume_id: 'ok' })])).toBe('ready');
  });
});

describe('resumeStateHint', () => {
  it('is null only when the action is available', () => {
    expect(resumeStateHint('ready', 'check')).toBeNull();
    expect(resumeStateHint('ready', 'apply')).toBeNull();
    for (const state of ['loading', 'unavailable', 'none', 'processing', 'failed'] as const) {
      expect(resumeStateHint(state, 'check')).toEqual(expect.any(String));
      expect(resumeStateHint(state, 'apply')).toEqual(expect.any(String));
    }
  });

  it('names the action that is blocked', () => {
    expect(resumeStateHint('none', 'check')).toBe('Upload a resume to run this check.');
    expect(resumeStateHint('none', 'apply')).toBe('Upload a resume to start an application.');
    expect(resumeStateHint('processing', 'apply')).toMatch(/finished processing/);
    expect(resumeStateHint('unavailable', 'check')).toMatch(/couldn't load/i);
  });
});

describe('resumeOptionLabel', () => {
  it('names the file and when it was uploaded', () => {
    const label = resumeOptionLabel(resume({ resume_id: 'x', original_filename: 'cv.pdf', created_at: '2026-10-27 12:59:21.123+00' }), {
      locale: 'en-US',
      timeZone: 'UTC',
    });
    expect(label).toBe('cv.pdf (uploaded Oct 27, 2026)');
  });

  it('is just the filename when the date is unreadable', () => {
    expect(resumeOptionLabel(resume({ resume_id: 'x', original_filename: 'cv.pdf', created_at: 'nope' }))).toBe('cv.pdf');
  });
});

describe('keywordBand', () => {
  it.each([
    [null, 'none'],
    [0, 'weak'],
    [39, 'weak'],
    [40, 'partial'],
    [69, 'partial'],
    [70, 'strong'],
    [100, 'strong'],
  ] as const)('%j -> %s', (score, band) => {
    expect(keywordBand(score)).toBe(band);
  });
});

function report(overrides: Partial<ResumeOptimizationReport> = {}): ResumeOptimizationReport {
  return {
    keyword_match: { score: 67, matched: ['typescript', 'postgresql'], missing: ['kubernetes'] },
    bullet_findings: [
      {
        company: 'Acme',
        title: 'Engineer',
        bullet_index: 2,
        bullet: 'Responsible for the billing service',
        issues: ['weak_opening', 'no_metric'],
        suggestions: ['Open with a strong action verb.', 'Add a measurable result if you can back it up.'],
      },
    ],
    ats: {
      score: 84.6,
      checks: [
        { id: 'a', label: 'Contact details', passed: true, weight: 0.3, hint: 'Add an email.' },
        { id: 'b', label: 'Summary section', passed: false, weight: 0.1, hint: 'Add a short summary.' },
        { id: 'c', label: 'Skills section', passed: false, weight: 0.4, hint: 'List your skills.' },
      ],
    },
    recommendations: ['Mention kubernetes only if you have used it.'],
    truthfulness_note: 'Advisory only. Atlas never edits your resume.',
    ...overrides,
  };
}

describe('toReportViewModel', () => {
  it('maps the score, band and keyword lists', () => {
    const view = toReportViewModel(report());
    expect(view.keywordScore).toBe(67);
    expect(view.band).toBe('partial');
    expect(view.bandLabel).toBe('Partial overlap');
    expect(view.matched).toEqual(['typescript', 'postgresql']);
    expect(view.missing).toEqual(['kubernetes']);
    expect(view.keywordSummary).toBe('2 of the 3 keywords we found in this posting appear in your resume.');
  });

  it('describes a posting with no keywords instead of showing a fake 0%', () => {
    const view = toReportViewModel(report({ keyword_match: { score: null, matched: [], missing: [] } }));
    expect(view.keywordScore).toBeNull();
    expect(view.band).toBe('none');
    expect(view.keywordSummary).toMatch(/nothing to compare/i);
    expect(view.announcement).toMatch(/no keywords/i);
  });

  it('uses the singular for one keyword', () => {
    const view = toReportViewModel(report({ keyword_match: { score: 100, matched: ['sql'], missing: [] } }));
    expect(view.keywordSummary).toBe('1 of the 1 keyword we found in this posting appears in your resume.');
  });

  it('labels bullet issues in plain language and says where each bullet lives', () => {
    const [finding] = toReportViewModel(report()).bulletFindings;
    expect(finding).toEqual({
      key: '0:Acme|Engineer|2',
      where: 'Engineer, Acme',
      bullet: 'Responsible for the billing service',
      issues: ['Weak opening', 'No measurable result'],
      suggestions: ['Open with a strong action verb.', 'Add a measurable result if you can back it up.'],
    });
  });

  it('lists only failed ATS checks, heaviest first, with a rounded score', () => {
    const view = toReportViewModel(report());
    expect(view.atsScore).toBe(85);
    expect(view.atsIssues).toEqual([
      { label: 'Skills section', hint: 'List your skills.' },
      { label: 'Summary section', hint: 'Add a short summary.' },
    ]);
  });

  it('passes recommendations and the truthfulness note through unchanged', () => {
    const view = toReportViewModel(report());
    expect(view.recommendations).toEqual(['Mention kubernetes only if you have used it.']);
    expect(view.truthfulnessNote).toBe('Advisory only. Atlas never edits your resume.');
  });

  it('always shows a truthfulness note, even if the response omits it', () => {
    expect(toReportViewModel(report({ truthfulness_note: '' })).truthfulnessNote).toBe(FALLBACK_TRUTHFULNESS_NOTE);
    expect(toReportViewModel(report({ truthfulness_note: '   ' })).truthfulnessNote).toBe(FALLBACK_TRUTHFULNESS_NOTE);
    expect(FALLBACK_TRUTHFULNESS_NOTE).toMatch(/advisory/i);
    expect(FALLBACK_TRUTHFULNESS_NOTE).toMatch(/never adds/i);
  });

  it('de-duplicates keywords case-insensitively and drops blanks', () => {
    const view = toReportViewModel(
      report({ keyword_match: { score: 50, matched: ['SQL', 'sql', ' ', 'Go'], missing: ['Rust', 'rust'] } }),
    );
    expect(view.matched).toEqual(['SQL', 'Go']);
    expect(view.missing).toEqual(['Rust']);
  });

  it('survives a response with empty lists', () => {
    const view = toReportViewModel(
      report({ bullet_findings: [], recommendations: [], ats: { score: 100, checks: [] } }),
    );
    expect(view.bulletFindings).toEqual([]);
    expect(view.recommendations).toEqual([]);
    expect(view.atsIssues).toEqual([]);
  });

  it('survives a response with missing lists instead of crashing the page', () => {
    const sparse = { keyword_match: { score: 10 }, truthfulness_note: 'x' } as unknown as ResumeOptimizationReport;
    const view = toReportViewModel(sparse);
    expect(view.matched).toEqual([]);
    expect(view.missing).toEqual([]);
    expect(view.bulletFindings).toEqual([]);
    expect(view.recommendations).toEqual([]);
    expect(view.atsScore).toBeNull();
  });

  it('is advisory by construction: no view field carries rewritten resume text', () => {
    // The only bullet text in the view is the user's own original bullet, verbatim.
    const input = report();
    const view = toReportViewModel(input);
    expect(view.bulletFindings.map((f) => f.bullet)).toEqual(input.bullet_findings.map((f) => f.bullet));
  });
});
