import { describe, expect, it } from 'vitest';
import { draftMessage } from '../src/lib/drafter.js';

describe('draftMessage', () => {
  it('references the role, company, contact, and skills when all are known', () => {
    const draft = draftMessage({
      candidateName: 'Ada Lovelace',
      jobTitle: 'Backend Engineer',
      companyName: 'Acme',
      contactName: 'Grace Hopper',
      contactTitle: 'Engineering Manager',
      topSkills: ['typescript', 'postgresql'],
    });
    expect(draft.subject).toBe('Interested in the Backend Engineer role at Acme');
    expect(draft.body).toContain('Grace Hopper');
    expect(draft.body).toContain('Backend Engineer');
    expect(draft.body).toContain('Acme');
    expect(draft.body).toContain('typescript, postgresql');
    expect(draft.body).toContain('Engineering Manager');
    expect(draft.body).toContain('Ada Lovelace');
  });

  it('degrades gracefully when almost nothing is known', () => {
    const draft = draftMessage({
      candidateName: null,
      jobTitle: null,
      companyName: null,
      contactName: null,
      contactTitle: null,
      topSkills: [],
    });
    expect(draft.subject).toBe('Quick introduction');
    expect(draft.body).toContain('Hello,');
    expect(draft.body).not.toContain('undefined');
    expect(draft.body).not.toContain('null');
  });

  it('drafts a contact-only outreach without a job/company', () => {
    const draft = draftMessage({
      candidateName: 'Ada',
      jobTitle: null,
      companyName: null,
      contactName: 'Grace',
      contactTitle: 'Recruiter',
      topSkills: [],
    });
    expect(draft.body).toContain('Hi Grace,');
    expect(draft.body).toContain('introduce myself');
  });
});
