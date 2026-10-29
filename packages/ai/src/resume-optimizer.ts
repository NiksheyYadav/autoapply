import type { BulletFinding, BulletIssue, ParsedProfile, ResumeOptimizationReport } from '@atlas/types';
import { scoreResume } from './ats-scorer.js';
import { containsKeyword, extractSkillKeywords } from './skills.js';

/** The slice of a job posting the optimizer reads. */
export interface OptimizationTarget {
  title: string;
  description: string | null;
  skills: string[];
}

export const TRUTHFULNESS_NOTE =
  'These suggestions are advisory. Atlas never adds skills, employers, or numbers to your resume for you — only include a keyword or metric if it is true.';

/** Findings/recommendations stay short — they're for display, not audit. */
const MAX_BULLET_FINDINGS = 20;
const MAX_RECOMMENDATIONS = 10;
const MAX_KEYWORDS_IN_RECOMMENDATION = 5;
const MAX_ATS_HINTS = 3;

const MIN_BULLET_CHARS = 25;
const MAX_BULLET_CHARS = 220;

const HAS_DIGIT_OR_PERCENT = /\d|%/;

/**
 * Openers that describe a duty rather than an outcome. First person is
 * included because "I managed…" reads as informal on a resume.
 */
const WEAK_OPENING =
  /^(?:i|responsible for|duties (?:included|include)|worked on|worked with|helped|helping|assisted|assisting|tasked with|involved in|in charge of|participated in)\b/i;

const EXAMPLE_VERBS = 'Built, Led, Reduced, Launched';

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

/** What the posting asks for: its explicit skill list plus vocabulary terms in the title/description. */
function collectJobKeywords(target: OptimizationTarget): string[] {
  const keywords = new Set<string>();
  for (const skill of target.skills) {
    const term = normalizeTerm(skill);
    if (term.length > 0) keywords.add(term);
  }
  for (const keyword of extractSkillKeywords(`${target.title}\n${target.description ?? ''}`)) {
    keywords.add(keyword);
  }
  return [...keywords];
}

function analyzeBullet(bullet: string): { issues: BulletIssue[]; suggestions: string[] } {
  const issues: BulletIssue[] = [];
  const suggestions: string[] = [];

  const weakOpening = bullet.match(WEAK_OPENING);
  if (weakOpening) {
    issues.push('weak_opening');
    suggestions.push(
      `Open with a strong action verb (for example: ${EXAMPLE_VERBS}) instead of "${weakOpening[0]}" — lead with what you did.`,
    );
  }
  if (!HAS_DIGIT_OR_PERCENT.test(bullet)) {
    issues.push('no_metric');
    suggestions.push(
      'Add a measurable result (scale, percentage, time or cost saved) if you can back it up — without inventing one.',
    );
  }
  if (bullet.length < MIN_BULLET_CHARS) {
    issues.push('too_short');
    suggestions.push('Say what you did and what came of it — a bullet this brief gives recruiters and ATS little to match.');
  } else if (bullet.length > MAX_BULLET_CHARS) {
    issues.push('too_long');
    suggestions.push('Trim this or split it into two bullets — long bullets are hard to scan.');
  }

  return { issues, suggestions };
}

function collectBulletFindings(profile: ParsedProfile): BulletFinding[] {
  const findings: BulletFinding[] = [];
  for (const entry of profile.experience) {
    entry.highlights.forEach((bullet, bulletIndex) => {
      const { issues, suggestions } = analyzeBullet(bullet);
      if (issues.length > 0) {
        findings.push({ company: entry.company, title: entry.title, bullet_index: bulletIndex, bullet, issues, suggestions });
      }
    });
  }
  // Worst bullets first; Array#sort is stable, so ties keep resume order.
  return findings.sort((a, b) => b.issues.length - a.issues.length);
}

function buildRecommendations(
  missing: string[],
  atsHints: string[],
  allFindings: BulletFinding[],
  keywordScore: number | null,
): string[] {
  const recommendations: string[] = [];

  if (missing.length > 0) {
    const shown = missing.slice(0, MAX_KEYWORDS_IN_RECOMMENDATION).join(', ');
    recommendations.push(
      `This posting mentions ${shown}, which your resume doesn't. If you genuinely have that experience, work it into a relevant bullet or your skills section.`,
    );
  }

  const missingMetric = allFindings.filter((f) => f.issues.includes('no_metric')).length;
  if (missingMetric > 0) {
    recommendations.push(`${missingMetric} bullet(s) have no measurable result — quantify the ones you can substantiate.`);
  }
  const weakOpenings = allFindings.filter((f) => f.issues.includes('weak_opening')).length;
  if (weakOpenings > 0) {
    recommendations.push(`${weakOpenings} bullet(s) open with a duty ("responsible for…") rather than an action verb.`);
  }

  recommendations.push(...atsHints);

  if (recommendations.length === 0) {
    recommendations.push(
      keywordScore === null
        ? 'This posting lists no recognizable keywords, so there is nothing to tailor against — your resume reads cleanly.'
        : 'Your resume already covers what this posting asks for and reads cleanly.',
    );
  }
  return recommendations.slice(0, MAX_RECOMMENDATIONS);
}

/**
 * Deterministic, job-aware advice for one parsed resume — the same "good
 * enough to make the pipeline real" bar as the parser, ATS scorer, and match
 * scorer (no model API key is configured anywhere in this repo). It reports
 * keyword coverage against the posting and flags weak bullets. It deliberately
 * never produces rewritten resume text: that would mean asserting claims the
 * candidate didn't make.
 */
export function analyzeResumeForJob(
  profile: ParsedProfile,
  rawText: string,
  target: OptimizationTarget,
): ResumeOptimizationReport {
  const profileTerms = new Set<string>([
    ...profile.skills.map((skill) => normalizeTerm(skill.name)),
    ...profile.keywords.map(normalizeTerm),
  ]);

  const jobKeywords = collectJobKeywords(target);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const keyword of jobKeywords) {
    (profileTerms.has(keyword) || containsKeyword(rawText, keyword) ? matched : missing).push(keyword);
  }
  const keywordScore = jobKeywords.length === 0 ? null : Math.round((100 * matched.length) / jobKeywords.length);

  const ats = scoreResume(profile, rawText);
  const failedHints = ats.checks
    .filter((check) => !check.passed)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_ATS_HINTS)
    .map((check) => check.hint);

  // Recommendations count every flagged bullet; the report only lists the worst.
  const allFindings = collectBulletFindings(profile);

  return {
    keyword_match: { score: keywordScore, matched, missing },
    bullet_findings: allFindings.slice(0, MAX_BULLET_FINDINGS),
    ats,
    recommendations: buildRecommendations(missing, failedHints, allFindings, keywordScore),
    truthfulness_note: TRUTHFULNESS_NOTE,
  };
}
