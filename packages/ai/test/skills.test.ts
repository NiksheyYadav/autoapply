import { describe, expect, it } from 'vitest';
import { extractSkillKeywords } from '../src/skills.js';

describe('extractSkillKeywords', () => {
  it('matches skills ending in punctuation followed by a word boundary', () => {
    expect(extractSkillKeywords('Experience with C++, C#, and Node.js.')).toEqual(
      expect.arrayContaining(['c++', 'c#', 'node.js']),
    );
  });

  it('matches a skill at the very end of the text with no trailing character', () => {
    expect(extractSkillKeywords('Ten years of Go')).toContain('go');
  });

  it('does not match a keyword that is only a substring of a longer word', () => {
    expect(extractSkillKeywords('I enjoy sales calls and salesforce administration')).toContain('salesforce');
    expect(extractSkillKeywords('salesfolks are great')).not.toContain('sales');
  });
});
