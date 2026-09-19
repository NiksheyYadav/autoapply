import type { AtsReport, ParsedProfile } from '@atlas/types';

interface CheckDef {
  id: string;
  label: string;
  weight: number;
  hint: string;
  passed: (profile: ParsedProfile, rawText: string) => boolean;
}

const HAS_DIGIT_OR_PERCENT = /\d|%/;

/** Weights sum to 1 — `score` below is just that weighted sum as a 0-100 integer. */
const CHECKS: CheckDef[] = [
  {
    id: 'has_email',
    label: 'Includes an email address',
    weight: 0.15,
    hint: 'Add a professional email address near the top of your resume.',
    passed: (p) => p.contact.email !== null,
  },
  {
    id: 'has_phone',
    label: 'Includes a phone number',
    weight: 0.1,
    hint: 'Add a phone number so recruiters can reach you.',
    passed: (p) => p.contact.phone !== null,
  },
  {
    id: 'has_skills',
    label: 'Lists specific skills',
    weight: 0.2,
    hint: 'List your key skills explicitly — ATS systems scan for keyword matches.',
    passed: (p) => p.skills.length > 0,
  },
  {
    id: 'has_summary',
    label: 'Opens with a summary or objective',
    weight: 0.1,
    hint: 'Add a brief summary or objective near the top.',
    passed: (p) => (p.summary?.length ?? 0) > 0,
  },
  {
    id: 'has_experience',
    label: 'Includes a work experience section',
    weight: 0.1,
    hint: 'Include a work experience section with roles, dates, and responsibilities.',
    passed: (p) => p.experience.length > 0,
  },
  {
    id: 'quantifies_achievements',
    label: 'Quantifies at least one achievement',
    weight: 0.2,
    hint: 'Quantify your achievements with numbers, e.g. "increased conversion by 30%".',
    passed: (p) => p.experience.some((entry) => entry.highlights.some((h) => HAS_DIGIT_OR_PERCENT.test(h))),
  },
  {
    id: 'reasonable_length',
    label: "Reads like a 1-2 page resume, not a snippet or a novel",
    weight: 0.15,
    hint: 'Aim for roughly 1-2 pages — automated screens tend to penalize resumes that are far too short or far too long.',
    passed: (_p, rawText) => rawText.trim().length >= 500 && rawText.trim().length <= 15000,
  },
];

export function scoreResume(profile: ParsedProfile, rawText: string): AtsReport {
  const checks = CHECKS.map((check) => ({
    id: check.id,
    label: check.label,
    passed: check.passed(profile, rawText),
    weight: check.weight,
    hint: check.hint,
  }));
  const score = Math.round(100 * checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0));
  return { score, checks };
}
