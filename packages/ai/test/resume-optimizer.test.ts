import { describe, expect, it } from 'vitest';
import { analyzeResumeForJob, TRUTHFULNESS_NOTE, type OptimizationTarget } from '../src/resume-optimizer.js';
import { parseResumeText } from '../src/resume-parser.js';

const RESUME = `Ada Lovelace
ada@example.com

Summary
Backend engineer with a focus on distributed systems.

Experience
Staff Engineer, Analytical Engines Inc
Jan 2021 - Present
- Cut P99 latency by 40% via a queue-based rewrite
- Responsible for the on-call rotation
- Worked on internal tooling

Skills
TypeScript, PostgreSQL, Docker
`;

function target(overrides: Partial<OptimizationTarget> = {}): OptimizationTarget {
  return { title: 'Backend Engineer', description: null, skills: [], ...overrides };
}

describe('analyzeResumeForJob', () => {
  const profile = parseResumeText(RESUME);

  it('splits the posting keywords into matched and missing, case-insensitively', () => {
    const report = analyzeResumeForJob(profile, RESUME, target({ skills: ['TypeScript', 'Kubernetes', 'docker'] }));
    expect(report.keyword_match.matched).toEqual(['typescript', 'docker']);
    expect(report.keyword_match.missing).toEqual(['kubernetes']);
    expect(report.keyword_match.score).toBe(67);
  });

  it('also picks up vocabulary terms mentioned only in the title or description', () => {
    const report = analyzeResumeForJob(
      profile,
      RESUME,
      target({ title: 'Platform Engineer', description: 'You will run Kubernetes on AWS and write TypeScript.' }),
    );
    expect(report.keyword_match.matched).toContain('typescript');
    expect(report.keyword_match.missing).toEqual(expect.arrayContaining(['kubernetes', 'aws']));
  });

  it('finds a job skill outside the shared vocabulary when the resume text states it', () => {
    const text = `${RESUME}\nAlso used Snowflake daily.`;
    const report = analyzeResumeForJob(parseResumeText(text), text, target({ skills: ['snowflake', 'dbt'] }));
    expect(report.keyword_match.matched).toEqual(['snowflake']);
    expect(report.keyword_match.missing).toEqual(['dbt']);
  });

  it('does not count a keyword that only appears inside a longer word', () => {
    const text = `${RESUME}\nLoves javascripting and the Javanese language.`;
    const report = analyzeResumeForJob(parseResumeText(text), text, target({ skills: ['java'] }));
    expect(report.keyword_match.missing).toEqual(['java']);
  });

  it('reports a null score, not 0 or 100, when the posting names no keywords', () => {
    const report = analyzeResumeForJob(profile, RESUME, target({ title: 'Wizard', description: 'Cast spells.' }));
    expect(report.keyword_match.score).toBeNull();
    expect(report.keyword_match.matched).toEqual([]);
    expect(report.keyword_match.missing).toEqual([]);
  });

  it('flags duty-style openers and bullets with no measurable result', () => {
    const report = analyzeResumeForJob(profile, RESUME, target());
    const byBullet = new Map(report.bullet_findings.map((f) => [f.bullet, f]));

    expect(byBullet.get('Responsible for the on-call rotation')?.issues).toEqual(
      expect.arrayContaining(['weak_opening', 'no_metric']),
    );
    expect(byBullet.get('Worked on internal tooling')?.issues).toContain('weak_opening');
    // The quantified, action-led bullet needs no work.
    expect(byBullet.has('Cut P99 latency by 40% via a queue-based rewrite')).toBe(false);
  });

  it('flags bullets that are too short or too long', () => {
    const longBullet = `Built ${'a very detailed internal reporting pipeline '.repeat(8)}for 12 teams`;
    const text = `Experience\nEngineer, Acme\nJan 2022 - Present\n- Did stuff\n- ${longBullet}\n`;
    const report = analyzeResumeForJob(parseResumeText(text), text, target());
    const issues = report.bullet_findings.flatMap((f) => f.issues);
    expect(issues).toContain('too_short');
    expect(issues).toContain('too_long');
  });

  it('lists the most-flawed bullets first and caps the list while still counting them all', () => {
    const bullets = Array.from({ length: 30 }, (_, i) => `- Helped with project number ${i} somehow today`).join('\n');
    const text = `Experience\nEngineer, Acme\nJan 2022 - Present\n${bullets}\n- Helped\n`;
    const parsed = parseResumeText(text);
    const report = analyzeResumeForJob(parsed, text, target());

    expect(report.bullet_findings).toHaveLength(20);
    // "Helped" is weak-opening + no_metric + too_short: three issues, so it leads.
    expect(report.bullet_findings[0]?.bullet).toBe('Helped');
    expect(report.bullet_findings[0]?.issues).toHaveLength(3);
    // The recommendation reflects all flagged bullets, not just the 20 shown.
    expect(report.recommendations.join(' ')).toMatch(/31 bullet\(s\) open with a duty/);
  });

  it('never presents a missing keyword as something the resume already has', () => {
    const report = analyzeResumeForJob(profile, RESUME, target({ skills: ['kubernetes', 'terraform'] }));
    const advice = report.recommendations.join(' ');

    expect(advice).toContain('kubernetes');
    expect(advice).toMatch(/if you genuinely have that experience/i);
    expect(report.keyword_match.matched).not.toContain('kubernetes');
    // No bullet suggestion injects a keyword the resume lacks.
    const suggestionText = report.bullet_findings.flatMap((f) => f.suggestions).join(' ').toLowerCase();
    expect(suggestionText).not.toContain('kubernetes');
    expect(suggestionText).not.toContain('terraform');
    expect(report.truthfulness_note).toBe(TRUTHFULNESS_NOTE);
  });

  it('includes the resume-level ATS report and surfaces its failed checks as advice', () => {
    const bare = 'hi';
    const report = analyzeResumeForJob(parseResumeText(bare), bare, target({ skills: ['python'] }));
    expect(report.ats.score).toBeLessThan(50);
    expect(report.recommendations.length).toBeGreaterThan(0);
    // Highest-weight failed checks come first; has_skills (0.2) outranks has_phone (0.1).
    expect(report.recommendations.join(' ')).toMatch(/skills/i);
  });

  it('says so, rather than returning nothing, when there is nothing to improve', () => {
    const strong = `Ada Lovelace
ada@example.com
+1 555 010 1234

Summary
Backend engineer focused on distributed systems and reliability.

Experience
Staff Engineer, Analytical Engines Inc
Jan 2021 - Present
- Cut P99 latency by 40% by rewriting the ingestion path as a queue-based pipeline
- Led a team of 6 engineers through a migration serving 2 million requests per day

Skills
TypeScript, PostgreSQL, Docker
${'Additional detail about shipped systems and outcomes. '.repeat(12)}
`;
    const report = analyzeResumeForJob(parseResumeText(strong), strong, target({ skills: ['typescript'] }));
    expect(report.keyword_match.score).toBe(100);
    expect(report.bullet_findings).toEqual([]);
    expect(report.recommendations).toHaveLength(1);
    expect(report.recommendations[0]).toMatch(/already covers/i);
  });
});
