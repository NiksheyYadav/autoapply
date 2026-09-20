import { describe, expect, it } from 'vitest';
import type { Job, ParsedProfile } from '@atlas/types';
import { scoreMatch } from '../src/lib/scorer.js';

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    job_id: 'job-1',
    company_id: 'company-1',
    title: 'Backend Engineer',
    description: null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    location: null,
    remote_type: 'remote',
    employment_type: 'full_time',
    source: 'manual',
    external_id: null,
    apply_url: null,
    job_hash: 'x'.repeat(64),
    skills: ['typescript', 'postgresql', 'docker'],
    posted_at: null,
    expires_at: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildProfile(overrides: Partial<ParsedProfile> = {}): ParsedProfile {
  return {
    full_name: 'Ada Lovelace',
    headline: null,
    summary: null,
    contact: { email: null, phone: null, location: null, links: [] },
    skills: [],
    experience: [],
    education: [],
    certifications: [],
    keywords: [],
    total_months_experience: 0,
    ...overrides,
  };
}

describe('scoreMatch', () => {
  it('scores higher when the candidate has every listed skill', () => {
    const job = buildJob();
    const strongProfile = buildProfile({
      skills: [
        { name: 'typescript', raw: 'TypeScript', months_experience: 24 },
        { name: 'postgresql', raw: 'PostgreSQL', months_experience: 24 },
        { name: 'docker', raw: 'Docker', months_experience: 24 },
      ],
      total_months_experience: 24,
    });
    const weakProfile = buildProfile({ total_months_experience: 24 });

    expect(scoreMatch(job, strongProfile).score).toBeGreaterThan(scoreMatch(job, weakProfile).score);
  });

  it('lists the missing skills as gaps, capped, and reports the match ratio', () => {
    const job = buildJob({ skills: ['typescript', 'postgresql', 'docker'] });
    const profile = buildProfile({
      skills: [{ name: 'typescript', raw: 'TypeScript', months_experience: 12 }],
      total_months_experience: 12,
    });

    const result = scoreMatch(job, profile);
    expect(result.skillGaps).toEqual(['postgresql', 'docker']);
    expect(result.reasons[0]).toContain('Matches 1 of 3');
  });

  it('does not penalize missing skills when the job lists none', () => {
    const job = buildJob({ skills: [] });
    const profile = buildProfile({ total_months_experience: 12 });
    const result = scoreMatch(job, profile);
    expect(result.score).toBeGreaterThan(0);
    expect(result.skillGaps).toEqual([]);
  });

  it('never penalizes experience for an entry-level/intern title', () => {
    const job = buildJob({ title: 'Software Engineering Intern', skills: [] });
    const seasoned = buildProfile({ total_months_experience: 120 });
    const fresh = buildProfile({ total_months_experience: 0 });
    expect(scoreMatch(job, fresh).score).toBe(scoreMatch(job, seasoned).score);
  });

  it('scores a senior title lower for a junior candidate than for a senior one', () => {
    const job = buildJob({ title: 'Senior Backend Engineer', skills: [] });
    const junior = buildProfile({ total_months_experience: 6 });
    const senior = buildProfile({ total_months_experience: 60 });
    expect(scoreMatch(job, senior).score).toBeGreaterThan(scoreMatch(job, junior).score);
  });

  it('keeps the score within [0, 1]', () => {
    const job = buildJob({ skills: ['typescript'] });
    const profile = buildProfile({
      skills: [{ name: 'typescript', raw: 'TypeScript', months_experience: 999 }],
      total_months_experience: 999,
    });
    const result = scoreMatch(job, profile);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
