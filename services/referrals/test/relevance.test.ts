import { describe, expect, it } from 'vitest';
import { scoreContactRelevance } from '../src/lib/relevance.js';

describe('scoreContactRelevance', () => {
  it('scores recruiters highest', () => {
    expect(scoreContactRelevance('Technical Recruiter')).toBe(0.9);
    expect(scoreContactRelevance('Talent Acquisition Partner')).toBe(0.9);
  });

  it('scores hiring leaders second', () => {
    expect(scoreContactRelevance('Engineering Manager')).toBe(0.85);
    expect(scoreContactRelevance('Director of Engineering')).toBe(0.85);
  });

  it('scores individual-contributor peers moderately', () => {
    expect(scoreContactRelevance('Senior Software Engineer')).toBe(0.5);
  });

  it('gives an unrecognized title a low but nonzero score', () => {
    expect(scoreContactRelevance('Office Manager')).toBe(0.3);
  });

  it('gives a missing title the lowest score, not zero', () => {
    expect(scoreContactRelevance(null)).toBe(0.2);
    expect(scoreContactRelevance('')).toBe(0.2);
  });
});
