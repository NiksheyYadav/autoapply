import { describe, expect, it } from 'vitest';
import { scoreResume } from '../src/ats-scorer.js';
import { parseResumeText } from '../src/resume-parser.js';

const STRONG_RESUME = `Ada Lovelace

Summary
Backend engineer with a focus on distributed systems.

Experience
Staff Engineer, Analytical Engines Inc
Jan 2021 - Present
- Cut P99 latency by 40% via a queue-based rewrite

Skills
TypeScript, PostgreSQL, Docker
`;

describe('scoreResume', () => {
  it('scores checks that sum to a 0-100 range and includes hints for failed checks', () => {
    const profile = parseResumeText('nothing@nowhere.test');
    const report = scoreResume(profile, 'nothing@nowhere.test');
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.checks.length).toBeGreaterThan(0);
    for (const check of report.checks) {
      expect(check.hint.length).toBeGreaterThan(0);
    }
  });

  it('scores a well-formed, quantified resume higher than a near-empty one', () => {
    const strongProfile = parseResumeText(STRONG_RESUME);
    const strongReport = scoreResume(strongProfile, STRONG_RESUME);

    const weakText = 'hi';
    const weakProfile = parseResumeText(weakText);
    const weakReport = scoreResume(weakProfile, weakText);

    expect(strongReport.score).toBeGreaterThan(weakReport.score);
  });

  it('passes the quantifies_achievements check only when a highlight has a number or percent', () => {
    const report = scoreResume(parseResumeText(STRONG_RESUME), STRONG_RESUME);
    const check = report.checks.find((c) => c.id === 'quantifies_achievements');
    expect(check?.passed).toBe(true);
  });
});
