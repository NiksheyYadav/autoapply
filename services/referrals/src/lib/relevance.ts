/**
 * Heuristic 0–1 relevance score for a contact's job title — same
 * "good enough to make the pipeline real" bar as the matching-service
 * scorer and `@atlas/ai`'s heuristics (no LLM key is configured anywhere in
 * this repo). People who can actually extend a referral score highest.
 */

const RECRUITER_PATTERN = /\b(recruiter|talent acquisition|talent partner|sourcer)\b/i;
const HIRING_LEADER_PATTERN = /\b(hiring manager|engineering manager|director|head of|vp\b|chief|principal)\b/i;
const PEER_PATTERN = /\b(engineer|developer|designer|analyst|scientist|programmer)\b/i;

export function scoreContactRelevance(title: string | null | undefined): number {
  if (!title || title.trim().length === 0) return 0.2;
  if (RECRUITER_PATTERN.test(title)) return 0.9;
  if (HIRING_LEADER_PATTERN.test(title)) return 0.85;
  if (PEER_PATTERN.test(title)) return 0.5;
  return 0.3;
}
