import { extractSkillKeywords } from '@atlas/ai';
import type { Database } from '@atlas/db';
import { createEvent, type EventBroker } from '@atlas/messaging';
import type { RawJobPosting, TraceContext } from '@atlas/types';
import { pgErrorCode } from '@atlas/utils';
import { findOrCreateByName } from '../repo/companies.js';
import {
  findByHash,
  findBySourceExternalId,
  insert,
  touchSeen,
  updateInPlace,
  type InsertJobInput,
  type UpdateJobInput,
} from '../repo/jobs.js';
import {
  coerceEmploymentType,
  coerceRemoteType,
  computeJobHash,
  estimateSpamScore,
  normalizeApplyUrl,
  normalizeWebsiteUrl,
} from './normalize.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

export function parsePostedAt(raw?: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The content hash that identifies a posting across sources (docs/02 § Design notes). */
export function hashPosting(posting: RawJobPosting): string {
  return computeJobHash(
    posting.company_name,
    posting.title,
    posting.location ?? null,
    coerceRemoteType(posting.remote_type),
  );
}

export interface IngestPostingContext {
  db: Database;
  broker: EventBroker;
  /** A fresh trace context for each `job.discovered` event (every posting is its own trace). */
  newTrace: () => TraceContext;
  /**
   * The posting's company when the caller has already resolved it (a source's postings all share
   * one). Without it the company is looked up, or created, per posting.
   */
  company?: { companyId: string };
  /**
   * What to do when the posting's (source, external id) is already stored under a different
   * content hash, i.e. the source edited the listing. `false` (the manual ingest endpoint) leaves
   * that as a failure; `true` (scheduled source ingestion) rewrites the stored listing, since
   * otherwise every edit upstream would be rejected for as long as it stayed edited.
   */
  updateChangedListings?: boolean;
}

export type IngestPostingOutcome =
  /** A new listing, and `job.discovered` published for it. */
  | { kind: 'inserted'; jobId: string }
  /** The same listing was already stored; its freshness was bumped. */
  | { kind: 'duplicate'; jobId: string }
  /** The stored listing was rewritten to match the source, and `job.discovered` published again. */
  | { kind: 'updated'; jobId: string };

function fieldsOf(posting: RawJobPosting, jobHash: string): UpdateJobInput {
  return {
    title: posting.title,
    description: posting.description ?? null,
    salaryMin: posting.salary_min ?? null,
    salaryMax: posting.salary_max ?? null,
    salaryCurrency: posting.salary_currency ?? null,
    location: posting.location ?? null,
    remoteType: coerceRemoteType(posting.remote_type),
    employmentType: coerceEmploymentType(posting.employment_type),
    applyUrl: normalizeApplyUrl(posting.apply_url),
    jobHash,
    skills: extractSkillKeywords(posting.description ?? ''),
    spamScore: estimateSpamScore(posting),
    postedAt: parsePostedAt(posting.posted_at),
  };
}

async function publishDiscovered(
  context: IngestPostingContext,
  job: { jobId: string; companyId: string; source: string; jobHash: string; title: string },
): Promise<void> {
  await context.broker.publish(
    createEvent(
      'job.discovered',
      { job_id: job.jobId, company_id: job.companyId, source: job.source, job_hash: job.jobHash, title: job.title },
      context.newTrace(),
    ),
  );
}

/**
 * Stores one posting: dedupe by content hash, insert if new, publish `job.discovered`. Shared by
 * `POST /v1/jobs/ingest` and the scheduled job-source ingestion, so both dedupe identically.
 *
 * Throws on a failure it cannot resolve (the caller counts the posting as rejected). Two ingests
 * racing to insert the same listing are not a failure: the loser sees the unique violation, finds
 * the winner's row and reports a duplicate.
 */
export async function ingestPosting(
  context: IngestPostingContext,
  posting: RawJobPosting,
): Promise<IngestPostingOutcome> {
  const { db } = context;
  const remoteType = coerceRemoteType(posting.remote_type);
  const jobHash = computeJobHash(posting.company_name, posting.title, posting.location ?? null, remoteType);

  const company =
    context.company ??
    (await findOrCreateByName(db, posting.company_name, normalizeWebsiteUrl(posting.company_website)));

  const existing = await findByHash(db, jobHash);
  if (existing) {
    await touchSeen(db, existing.jobId);
    return { kind: 'duplicate', jobId: existing.jobId };
  }

  try {
    if (context.updateChangedListings === true && posting.external_id) {
      const sameListing = await findBySourceExternalId(db, posting.source, posting.external_id);
      if (sameListing) {
        await updateInPlace(db, sameListing.jobId, fieldsOf(posting, jobHash));
        await publishDiscovered(context, {
          jobId: sameListing.jobId,
          companyId: sameListing.companyId,
          source: sameListing.source,
          jobHash,
          title: posting.title,
        });
        return { kind: 'updated', jobId: sameListing.jobId };
      }
    }

    const input: InsertJobInput = {
      ...fieldsOf(posting, jobHash),
      companyId: company.companyId,
      source: posting.source,
      externalId: posting.external_id,
    };
    const job = await insert(db, input);
    await publishDiscovered(context, job);
    return { kind: 'inserted', jobId: job.jobId };
  } catch (cause) {
    // Another ingest won the race to store this exact listing between our lookups and our write:
    // that's a duplicate, not a failure.
    if (pgErrorCode(cause) === UNIQUE_VIOLATION) {
      const raced = await findByHash(db, jobHash);
      if (raced) {
        await touchSeen(db, raced.jobId);
        return { kind: 'duplicate', jobId: raced.jobId };
      }
    }
    throw cause;
  }
}
