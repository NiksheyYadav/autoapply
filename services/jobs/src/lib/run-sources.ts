import type { Database, schema } from '@atlas/db';
import type { EventBroker } from '@atlas/messaging';
import type {
  DeactivationSkipReason,
  IngestSourcesReport,
  JobBoardSourceRunResult,
  JobBoardSourceStatus,
  RawJobPosting,
} from '@atlas/types';
import { newTraceContext, type Logger } from '@atlas/utils';
import { findOrCreateByName } from '../repo/companies.js';
import { deactivateUnseenSince, findJobIdsByHashes, touchSeenMany } from '../repo/jobs.js';
import { countEnabled, databaseNow, listDue, recordRun, type RecordedRun } from '../repo/job-sources.js';
import { hashPosting, ingestPosting } from './ingest-posting.js';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_SOURCE_TIMEOUT_MS,
  fetchSourcePostings,
  SourceFetchError,
} from './job-sources/fetch-source.js';
import type { MappedJobs } from './job-sources/common.js';

type SourceRow = typeof schema.jobSources.$inferSelect;

/** Boards read at the same time. Each also runs its own few postings at once, so keep the product under the DB pool. */
export const DEFAULT_SOURCE_CONCURRENCY = 3;
/** Postings written at the same time within one board. */
export const POSTING_CONCURRENCY = 3;
/** A board is not started with less than this left: a fetch would have no time to finish. */
export const MIN_WINDOW_TO_START_SOURCE_MS = 1_500;
export const DEFAULT_SOURCE_LIMIT = 50;
/** `job_sources.last_error` holds a sentence, not a log. */
export const MAX_LAST_ERROR_LENGTH = 200;

/**
 * A board that listed fewer than this fraction of what it listed last time (and last time was
 * at least {@link SHARP_DROP_MIN_PREVIOUS}) does not get its vanished postings deactivated on the
 * first sighting. The count recorded for the board is updated either way, so the same listing
 * seen on the next run is the "second sighting" and goes through. A glitch that truncates a
 * response therefore cannot wipe a company's postings; a real clear-out is applied one run late.
 */
export const SHARP_DROP_RATIO = 0.2;
export const SHARP_DROP_MIN_PREVIOUS = 10;

export interface DeactivationInput {
  /** Postings the source listed on this run that mapped to something valid. */
  listed: number;
  /** What the previous successful run listed; null if there was none. */
  previousListed: number | null;
  /** Postings that could not be stored. Any one of them might have been a still-listed job. */
  rejected: number;
  /** False if the run stopped before every listed posting had been processed. */
  complete: boolean;
}

/**
 * Whether the postings a source no longer lists may be marked inactive. Only ever consulted for a
 * source that was fetched successfully; a failed fetch never reaches it. Pure, so the guard is
 * tested on its own.
 */
export function decideDeactivation(input: DeactivationInput): { apply: true } | { apply: false; reason: DeactivationSkipReason } {
  if (input.listed === 0) return { apply: false, reason: 'empty_result' };
  if (!input.complete) return { apply: false, reason: 'incomplete_run' };
  if (input.rejected > 0) return { apply: false, reason: 'rejected_postings' };
  if (
    input.previousListed !== null &&
    input.previousListed >= SHARP_DROP_MIN_PREVIOUS &&
    input.listed < input.previousListed * SHARP_DROP_RATIO
  ) {
    return { apply: false, reason: 'sharp_drop' };
  }
  return { apply: true };
}

export interface RunSourcesDeps {
  db: Database;
  broker: EventBroker;
  logger: Logger;
  /** Injected; production passes the global `fetch`. */
  fetch: typeof fetch;
  userAgent: string;
}

export interface RunSourcesOptions {
  /** Wall-clock budget for the whole run, from the moment it starts. */
  budgetMs: number;
  /** Most boards to read in one run. */
  limit?: number;
  /** Restrict the run to these (enabled) sources, e.g. to try one board right after adding it. */
  sourceIds?: readonly string[];
  sourceConcurrency?: number;
  postingConcurrency?: number;
  sourceTimeoutMs?: number;
  maxResponseBytes?: number;
  /** Clock, in epoch milliseconds. Injected by tests. */
  now?: () => number;
}

/**
 * Runs `worker` over `items`, at most `limit` at a time, starting no new item once `shouldStop()`
 * says so. Resolves to whether every item was started.
 */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean,
): Promise<boolean> {
  let next = 0;
  let stopped = false;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      if (index >= items.length) return;
      if (shouldStop()) {
        stopped = true;
        return;
      }
      next += 1;
      await worker(items[index] as T, index);
    }
  });
  await Promise.all(lanes);
  return !stopped;
}

function shorten(message: string): string {
  return message.length > MAX_LAST_ERROR_LENGTH ? `${message.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…` : message;
}

function emptyResult(source: SourceRow): JobBoardSourceRunResult {
  return {
    source_id: source.sourceId,
    provider: source.provider,
    board_token: source.boardToken,
    status: 'error',
    fetched: 0,
    skipped: 0,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    rejected: 0,
    deactivated: 0,
    deactivation_skipped: null,
    duration_ms: 0,
    error: null,
  };
}

interface RunContext {
  deps: RunSourcesDeps;
  deadline: number;
  now: () => number;
  postingConcurrency: number;
  sourceTimeoutMs: number;
  maxResponseBytes: number;
}

/** Stamps a source's outcome; a failure to do so must not take the rest of the run down with it. */
async function record(context: RunContext, source: SourceRow, run: RecordedRun): Promise<void> {
  try {
    await recordRun(context.deps.db, source.sourceId, run);
  } catch (error) {
    context.deps.logger.error({ err: error, source_id: source.sourceId }, 'could not record job source status');
  }
}

/** Stores a source's postings. Throws only for a database failure the whole source should be marked with. */
async function storePostings(
  context: RunContext,
  source: SourceRow,
  postings: readonly RawJobPosting[],
  result: JobBoardSourceRunResult,
): Promise<{ complete: boolean; sweepBefore: string; companyId: string }> {
  const { db, broker, logger } = context.deps;

  // A database timestamp: every listing this run touches is stamped later than it.
  const sweepBefore = await databaseNow(db);
  const company = await findOrCreateByName(db, source.companyName, null);

  // Most postings on a board you have read before are unchanged. Settle those with a statement per
  // few hundred of them, and spend the per-posting statements only on what is new or edited.
  const hashed = postings.map((posting) => ({ posting, jobHash: hashPosting(posting) }));
  const known = await findJobIdsByHashes(db, hashed.map((entry) => entry.jobHash));
  await touchSeenMany(db, [...known.values()]);
  const fresh = hashed.filter((entry) => !known.has(entry.jobHash));
  result.duplicates += hashed.length - fresh.length;

  const complete = await forEachLimited(
    fresh,
    context.postingConcurrency,
    async ({ posting }) => {
      try {
        const outcome = await ingestPosting(
          {
            db,
            broker,
            newTrace: () => newTraceContext(),
            company,
            updateChangedListings: true,
          },
          posting,
        );
        if (outcome.kind === 'inserted') result.inserted += 1;
        else if (outcome.kind === 'updated') result.updated += 1;
        else result.duplicates += 1;
      } catch (cause) {
        result.rejected += 1;
        // The driver message embeds SQL and the whole posting; it stays in the logs.
        if (result.rejected <= 3) {
          logger.error({ err: cause, source_id: source.sourceId, external_id: posting.external_id }, 'failed to store a job posting');
        }
      }
    },
    () => context.now() >= context.deadline,
  );

  return { complete, sweepBefore, companyId: company.companyId };
}

async function ingestSource(context: RunContext, source: SourceRow): Promise<JobBoardSourceRunResult> {
  const { logger } = context.deps;
  const startedAt = context.now();
  const result = emptyResult(source);
  const finish = (): JobBoardSourceRunResult => {
    result.duration_ms = context.now() - startedAt;
    return result;
  };
  const fail = async (message: string): Promise<JobBoardSourceRunResult> => {
    result.status = 'error';
    result.error = shorten(message);
    await record(context, source, { status: 'error', error: result.error });
    return finish();
  };

  let mapped: MappedJobs;
  try {
    mapped = await fetchSourcePostings(
      { provider: source.provider, boardToken: source.boardToken, companyName: source.companyName },
      {
        fetch: context.deps.fetch,
        userAgent: context.deps.userAgent,
        // Never longer than what is left of the run, but long enough to be a real attempt.
        timeoutMs: Math.max(1_000, Math.min(context.sourceTimeoutMs, context.deadline - context.now())),
        maxBytes: context.maxResponseBytes,
      },
    );
  } catch (error) {
    if (error instanceof SourceFetchError) {
      logger.warn({ source_id: source.sourceId, provider: source.provider, board_token: source.boardToken, code: error.code }, 'job source could not be read');
      return fail(error.message);
    }
    logger.error({ err: error, source_id: source.sourceId }, 'unexpected failure reading a job source');
    return fail('unexpected error while reading the source');
  }

  result.fetched = mapped.postings.length;
  result.skipped = mapped.skipped;

  try {
    const stored = await storePostings(context, source, mapped.postings, result);

    const decision = decideDeactivation({
      listed: mapped.postings.length,
      previousListed: source.lastJobCount,
      rejected: result.rejected,
      complete: stored.complete,
    });
    if (decision.apply) {
      result.deactivated = await deactivateUnseenSince(
        context.deps.db,
        { source: source.provider, companyId: stored.companyId },
        stored.sweepBefore,
      );
    } else {
      result.deactivation_skipped = decision.reason;
      if (decision.reason === 'sharp_drop') {
        logger.warn(
          { source_id: source.sourceId, listed: mapped.postings.length, previous: source.lastJobCount },
          'job source listing shrank sharply; not deactivating until the next run confirms it',
        );
      }
    }

    const problems: string[] = [];
    if (!stored.complete) problems.push('time budget ran out before every posting was processed');
    if (result.rejected > 0) problems.push(`${result.rejected} posting(s) could not be stored`);
    const status: JobBoardSourceStatus = problems.length === 0 ? 'ok' : 'partial';
    result.status = status;
    result.error = problems.length === 0 ? null : shorten(problems.join('; '));
    await record(context, source, { status, error: result.error, jobCount: mapped.postings.length });
    return finish();
  } catch (error) {
    // Postgres/ORM messages carry SQL and row values; only a fixed sentence is stored.
    logger.error({ err: error, source_id: source.sourceId }, 'database failure while storing job postings');
    return fail('database error while storing postings');
  }
}

/**
 * One scheduled pass over the enabled job sources: least recently fetched first, a few at a time,
 * inside a wall-clock budget. A board that fails is recorded and skipped; the run goes on.
 */
export async function runSourceIngestion(
  deps: RunSourcesDeps,
  options: RunSourcesOptions,
): Promise<IngestSourcesReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const context: RunContext = {
    deps,
    now,
    deadline: startedAt + options.budgetMs,
    postingConcurrency: options.postingConcurrency ?? POSTING_CONCURRENCY,
    sourceTimeoutMs: options.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };

  const due = await listDue(deps.db, options.limit ?? DEFAULT_SOURCE_LIMIT, options.sourceIds);
  // With a restriction, "all sources" means the ones asked for.
  const sourcesTotal = await countEnabled(deps.db, options.sourceIds);

  const results: Array<JobBoardSourceRunResult | undefined> = new Array<JobBoardSourceRunResult | undefined>(due.length).fill(undefined);
  await forEachLimited(
    due,
    options.sourceConcurrency ?? DEFAULT_SOURCE_CONCURRENCY,
    async (source, index) => {
      results[index] = await ingestSource(context, source);
    },
    () => context.deadline - now() < MIN_WINDOW_TO_START_SOURCE_MS,
  );

  const sources = results.filter((entry): entry is JobBoardSourceRunResult => entry !== undefined);
  const sum = (pick: (entry: JobBoardSourceRunResult) => number): number =>
    sources.reduce((total, entry) => total + pick(entry), 0);
  const report: IngestSourcesReport = {
    sources_total: sourcesTotal,
    attempted: sources.length,
    succeeded: sources.filter((entry) => entry.status !== 'error').length,
    failed: sources.filter((entry) => entry.status === 'error').length,
    not_attempted: Math.max(0, sourcesTotal - sources.length),
    inserted: sum((entry) => entry.inserted),
    updated: sum((entry) => entry.updated),
    duplicates: sum((entry) => entry.duplicates),
    rejected: sum((entry) => entry.rejected),
    deactivated: sum((entry) => entry.deactivated),
    duration_ms: now() - startedAt,
    sources,
  };
  deps.logger.info({ ...report, sources: undefined }, 'job source ingestion finished');
  return report;
}
