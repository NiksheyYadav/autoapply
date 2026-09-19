import type { EmploymentType, RawJobPosting, RemoteType } from '@atlas/types';
import { sha256Hex } from '@atlas/utils';

const COMPANY_SUFFIX_RE = /\b(incorporated|limited|company|inc|llc|ltd|corp|co)\.?\s*$/i;

/** Lowercased, whitespace-collapsed, common-suffix-stripped — the cross-source dedupe join key. */
export function normalizeCompanyName(name: string): string {
  const collapsed = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return collapsed.replace(COMPANY_SUFFIX_RE, '').trim();
}

/** SHA-256 over the normalized fields — two sources posting the same role collapse to one row. */
export function computeJobHash(companyName: string, title: string, location: string | null, remoteType: string): string {
  const normalized = [
    normalizeCompanyName(companyName),
    title.trim().toLowerCase().replace(/\s+/g, ' '),
    (location ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
    remoteType,
  ].join('|');
  return sha256Hex(normalized);
}

export function coerceRemoteType(raw?: string | null): RemoteType {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (lower.includes('remote')) return 'remote';
  if (lower.includes('hybrid')) return 'hybrid';
  if (lower.includes('onsite') || lower.includes('on-site') || lower.includes('in office') || lower.includes('in-office')) {
    return 'onsite';
  }
  return 'unknown';
}

export function coerceEmploymentType(raw?: string | null): EmploymentType {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (lower.includes('intern')) return 'internship';
  if (lower.includes('contract')) return 'contract';
  if (lower.includes('part')) return 'part_time';
  if (lower.includes('full')) return 'full_time';
  return 'unknown';
}

/**
 * `jobSchema.apply_url` requires a real URL, but `rawJobPostingSchema`
 * deliberately accepts any string a connector hands us — normalize instead
 * of storing (and later serving) something that fails the API contract.
 */
export function normalizeApplyUrl(raw?: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).toString();
  } catch {
    return null;
  }
}

/**
 * A heuristic, not a classifier — 0 by default, bumped for the handful of
 * signals a genuine posting is very unlikely to be missing. Callers decide
 * what to do with the score; this never rejects a posting itself.
 */
export function estimateSpamScore(posting: RawJobPosting): number {
  let score = 0;
  if (!posting.apply_url) score += 0.4;
  if (posting.title.trim().length < 4) score += 0.3;
  if (!posting.description || posting.description.trim().length < 40) score += 0.3;
  return Math.min(1, score);
}
