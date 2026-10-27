import type { BulletIssue, Resume, ResumeOptimizationReport } from '@atlas/types';
import { formatServiceDate, parseServiceTimestamp } from '../applications/timestamp';

/**
 * Shown if a response ever arrives without the note. The check is advisory and
 * never edits the resume; the page must not read as if it did.
 */
export const FALLBACK_TRUTHFULNESS_NOTE =
  'These suggestions are advisory. Atlas never adds skills, employers, or numbers to your resume for you — only include a keyword or metric if it is true.';

// --- choosing a resume ------------------------------------------------------

/**
 * Only resumes that finished parsing can be checked or applied with
 * (profile-service answers 409 for the rest), newest first. Timestamps are read
 * leniently; rows whose date can't be read keep their incoming order, after the
 * dated ones.
 */
export function pickParsedResumes(resumes: readonly Resume[]): Resume[] {
  const parsed = resumes.filter((resume) => resume.status === 'parsed');
  const time = (resume: Resume): number => parseServiceTimestamp(resume.created_at)?.getTime() ?? Number.NEGATIVE_INFINITY;
  // Array#sort is stable, so equal/unreadable dates keep the order the API gave.
  return parsed.sort((a, b) => time(b) - time(a));
}

/** The most recent parsed resume, or null when there is none to check. */
export function defaultResumeId(resumes: readonly Resume[]): string | null {
  return pickParsedResumes(resumes)[0]?.resume_id ?? null;
}

export function resumeOptionLabel(resume: Resume, options: { locale?: string; timeZone?: string } = {}): string {
  const uploaded = formatServiceDate(resume.created_at, { ...options, fallback: '' });
  return uploaded ? `${resume.original_filename} (uploaded ${uploaded})` : resume.original_filename;
}

/** What to tell a user who can't run the check yet, based on the resumes they have. */
export type ResumeAvailability = 'none' | 'processing' | 'failed' | 'ready';

export function resumeAvailability(resumes: readonly Resume[]): ResumeAvailability {
  if (resumes.length === 0) return 'none';
  if (resumes.some((resume) => resume.status === 'parsed')) return 'ready';
  if (resumes.some((resume) => resume.status === 'pending' || resume.status === 'processing')) return 'processing';
  return 'failed';
}

// --- the report -------------------------------------------------------------

export type KeywordBand = 'strong' | 'partial' | 'weak' | 'none';

export interface BulletFindingView {
  key: string;
  /** "Senior Engineer, Acme" — where in the resume the bullet lives. */
  where: string;
  bullet: string;
  issues: string[];
  suggestions: string[];
}

export interface AtsCheckView {
  label: string;
  hint: string;
}

export interface ReportViewModel {
  /** 0–100, or null when the posting names no keywords to compare against. */
  keywordScore: number | null;
  band: KeywordBand;
  bandLabel: string;
  keywordSummary: string;
  matched: string[];
  missing: string[];
  bulletFindings: BulletFindingView[];
  atsScore: number | null;
  /** Only the checks that did not pass, heaviest first. */
  atsIssues: AtsCheckView[];
  recommendations: string[];
  truthfulnessNote: string;
  /** One sentence for the polite live region. */
  announcement: string;
}

const ISSUE_LABELS: Record<BulletIssue, string> = {
  weak_opening: 'Weak opening',
  no_metric: 'No measurable result',
  too_short: 'Too short',
  too_long: 'Too long',
};

const BAND_LABELS: Record<KeywordBand, string> = {
  strong: 'Strong overlap',
  partial: 'Partial overlap',
  weak: 'Low overlap',
  none: 'Nothing to compare',
};

export function keywordBand(score: number | null): KeywordBand {
  if (score === null) return 'none';
  if (score >= 70) return 'strong';
  if (score >= 40) return 'partial';
  return 'weak';
}

function dedupeKeywords(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function summarise(score: number | null, matched: number, missing: number): string {
  if (score === null) {
    return "This posting doesn't list keywords we can recognise, so there is nothing to compare your resume against.";
  }
  const total = matched + missing;
  return `${matched} of the ${total} keyword${total === 1 ? '' : 's'} we found in this posting appear${matched === 1 ? 's' : ''} in your resume.`;
}

/**
 * Turns the optimize report into what the panel renders. Defensive about every
 * list, because a missing array should degrade to "nothing to show" rather than
 * crash the page. It only reads the report: no field here rewrites or adds
 * resume content.
 */
export function toReportViewModel(report: ResumeOptimizationReport): ReportViewModel {
  const matched = dedupeKeywords(report.keyword_match?.matched);
  const missing = dedupeKeywords(report.keyword_match?.missing);
  const keywordScore = typeof report.keyword_match?.score === 'number' ? report.keyword_match.score : null;
  const band = keywordBand(keywordScore);

  const bulletFindings = (report.bullet_findings ?? []).map((finding) => ({
    key: `${finding.company}|${finding.title}|${finding.bullet_index}`,
    where: [finding.title, finding.company].filter((part) => part.length > 0).join(', '),
    bullet: finding.bullet,
    issues: finding.issues.map((issue) => ISSUE_LABELS[issue] ?? issue.replaceAll('_', ' ')),
    suggestions: finding.suggestions,
  }));

  const atsChecks = report.ats?.checks ?? [];
  const atsIssues = atsChecks
    .filter((check) => !check.passed)
    .sort((a, b) => b.weight - a.weight)
    .map((check) => ({ label: check.label, hint: check.hint }));

  const note = typeof report.truthfulness_note === 'string' ? report.truthfulness_note.trim() : '';

  return {
    keywordScore,
    band,
    bandLabel: BAND_LABELS[band],
    keywordSummary: summarise(keywordScore, matched.length, missing.length),
    matched,
    missing,
    bulletFindings,
    atsScore: typeof report.ats?.score === 'number' ? Math.round(report.ats.score) : null,
    atsIssues,
    recommendations: (report.recommendations ?? []).filter((line) => line.trim().length > 0),
    truthfulnessNote: note.length > 0 ? note : FALLBACK_TRUTHFULNESS_NOTE,
    announcement:
      keywordScore === null
        ? 'Resume check complete. This posting lists no keywords to compare against.'
        : `Resume check complete. ${keywordScore}% keyword overlap: ${matched.length} matched, ${missing.length} missing.`,
  };
}
