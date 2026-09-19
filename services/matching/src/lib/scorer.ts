import type { Job, ParsedProfile } from '@atlas/types';

export const MODEL_VERSION = 'heuristic-v1';

/** Reasons/skill-gap lists stay short — they're for display, not audit. */
const MAX_REASONS = 5;
const MAX_SKILL_GAPS = 20;

const SENIOR_TITLE_PATTERN = /\b(senior|staff|principal|lead)\b/i;
const JUNIOR_TITLE_PATTERN = /\b(junior|entry[\s-]?level|intern(ship)?|associate)\b/i;

export interface MatchResult {
  score: number;
  reasons: string[];
  skillGaps: string[];
}

/**
 * Months of experience a role's title implies, used only to scale the
 * experience-fit component below — there's no seniority field on `Job` to
 * read directly.
 */
function expectedMonthsForTitle(title: string): number {
  if (SENIOR_TITLE_PATTERN.test(title)) return 36;
  if (JUNIOR_TITLE_PATTERN.test(title)) return 0;
  return 12;
}

/**
 * Heuristic compatibility score between one job and one candidate profile —
 * the same "good enough to make the pipeline real" bar as the resume parser
 * and ATS scorer in `@atlas/ai` (no model API key is configured anywhere in
 * this repo). Two components:
 *  - skill overlap (70%): how much of what the job asks for the candidate has.
 *  - experience fit (30%): whether total experience meets what the title implies.
 */
export function scoreMatch(job: Job, profile: ParsedProfile): MatchResult {
  const candidateSkills = new Set(profile.skills.map((skill) => skill.name));
  const jobSkills = job.skills;

  const matchedSkills = jobSkills.filter((skill) => candidateSkills.has(skill));
  const skillGaps = jobSkills.filter((skill) => !candidateSkills.has(skill));
  // A job that lists no explicit skills makes no skill-based claim either way.
  const skillFit = jobSkills.length === 0 ? 0.5 : matchedSkills.length / jobSkills.length;

  const expectedMonths = expectedMonthsForTitle(job.title);
  const experienceFit = expectedMonths === 0 ? 1 : Math.min(profile.total_months_experience / expectedMonths, 1);

  const score = Math.min(Math.max(skillFit * 0.7 + experienceFit * 0.3, 0), 1);

  const reasons: string[] = [];
  if (jobSkills.length > 0) {
    reasons.push(`Matches ${matchedSkills.length} of ${jobSkills.length} listed skills`);
    if (matchedSkills.length > 0) {
      reasons.push(`Matched skills: ${matchedSkills.slice(0, MAX_REASONS - reasons.length).join(', ')}`);
    }
  }
  if (expectedMonths > 0) {
    const years = (profile.total_months_experience / 12).toFixed(1);
    reasons.push(
      profile.total_months_experience >= expectedMonths
        ? `${years} years of experience meets this role's level`
        : `${years} years of experience is below this role's typical level`,
    );
  }

  return {
    score,
    reasons: reasons.slice(0, MAX_REASONS),
    skillGaps: skillGaps.slice(0, MAX_SKILL_GAPS),
  };
}
