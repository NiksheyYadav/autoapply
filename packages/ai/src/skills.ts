/**
 * ~90 common tech/business terms. Shared between resume parsing (skills a
 * candidate lists) and job normalization (skills implied by a posting's
 * description) so both sides of matching draw from the same vocabulary.
 */
export const CANONICAL_SKILLS = [
  'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c++', 'c#', 'ruby', 'php', 'sql', 'html', 'css',
  'react', 'vue', 'angular', 'node.js', 'next.js', 'express', 'django', 'flask', 'spring', 'rails',
  'postgresql', 'mysql', 'mongodb', 'redis', 'kafka', 'rabbitmq', 'elasticsearch', 'graphql', 'rest api',
  'docker', 'kubernetes', 'terraform', 'ansible', 'aws', 'azure', 'gcp', 'ci/cd', 'jenkins', 'github actions',
  'git', 'linux', 'bash', 'agile', 'scrum', 'jira', 'figma', 'excel', 'tableau', 'power bi', 'salesforce',
  'machine learning', 'deep learning', 'nlp', 'pytorch', 'tensorflow', 'pandas', 'numpy', 'spark', 'hadoop',
  'project management', 'product management', 'data analysis', 'data engineering', 'devops', 'sre',
  'leadership', 'communication', 'stakeholder management', 'budgeting', 'forecasting', 'negotiation',
  'sales', 'marketing', 'seo', 'content strategy', 'copywriting', 'accounting', 'bookkeeping',
];

/** Returns the canonical keywords (lowercase) found in `text`, deduped, in list order. */
export function extractSkillKeywords(text: string): string[] {
  const lowerText = text.toLowerCase();
  return CANONICAL_SKILLS.filter((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `\b` requires a word/non-word transition, which never fires right after
    // a symbol like the trailing `+` in "c++" followed by a comma or space —
    // both sides are non-word characters. Anchoring on alphanumeric adjacency
    // instead handles keywords that end (or start) in punctuation correctly.
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(lowerText);
  });
}
