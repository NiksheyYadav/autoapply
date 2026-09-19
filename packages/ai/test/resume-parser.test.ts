import { describe, expect, it } from 'vitest';
import { parseResumeText } from '../src/resume-parser.js';

const WELL_FORMATTED_RESUME = `Ada Lovelace

Summary
Backend engineer with a focus on distributed systems and developer tooling.

Experience
Staff Engineer, Analytical Engines Inc
Jan 2021 - Present
- Led the migration to a queue-based architecture, cutting P99 latency by 40%
- Mentored 5 engineers across two teams

Software Engineer, Babbage Systems
Jun 2018 - Dec 2020
- Built the first version of the billing pipeline
- Shipped a Python microservice handling 2M requests/day

Education
University of London
Bachelor of Science in Mathematics
2014 - 2018
GPA: 3.8

Skills
TypeScript, PostgreSQL, Docker, Kubernetes, AWS

Certifications
AWS Certified Solutions Architect
`;

const SPARSE_TEXT = 'Just a name and nothing else, no sections at all here really.';

describe('parseResumeText', () => {
  it('extracts contact details', () => {
    const withContact = 'Jane Doe\njane.doe@example.com\n(555) 123-4567\nhttps://linkedin.com/in/janedoe\n' + WELL_FORMATTED_RESUME;
    const profile = parseResumeText(withContact);
    expect(profile.contact.email).toBe('jane.doe@example.com');
    expect(profile.contact.phone).toContain('555');
    expect(profile.contact.links[0]).toContain('linkedin.com/in/janedoe');
  });

  it('splits sections and extracts experience with highlights and dates', () => {
    const profile = parseResumeText(WELL_FORMATTED_RESUME);
    expect(profile.summary).toContain('distributed systems');
    expect(profile.experience.length).toBeGreaterThanOrEqual(2);
    const staffRole = profile.experience[0];
    expect(staffRole?.company).toContain('Analytical Engines');
    expect(staffRole?.period.is_current).toBe(true);
    expect(staffRole?.highlights.some((h) => h.includes('40%'))).toBe(true);
  });

  it('parses education with degree, field, and GPA', () => {
    const profile = parseResumeText(WELL_FORMATTED_RESUME);
    const edu = profile.education[0];
    expect(edu?.institution).toContain('University of London');
    expect(edu?.degree?.toLowerCase()).toContain('bachelor');
    expect(edu?.gpa).toBeCloseTo(3.8);
  });

  it('detects skills from an explicit skills section and via keyword scan', () => {
    const profile = parseResumeText(WELL_FORMATTED_RESUME);
    const names = profile.skills.map((s) => s.name);
    expect(names).toContain('typescript');
    expect(names).toContain('kubernetes');
  });

  it('computes total months of experience from parsed date ranges', () => {
    const profile = parseResumeText(WELL_FORMATTED_RESUME);
    expect(profile.total_months_experience).toBeGreaterThan(12);
  });

  it('never throws on sparse or unstructured input, and returns empty (not fabricated) fields', () => {
    const profile = parseResumeText(SPARSE_TEXT);
    expect(profile.experience).toEqual([]);
    expect(profile.education).toEqual([]);
    expect(profile.contact.email).toBeNull();
    expect(profile.total_months_experience).toBe(0);
  });
});
