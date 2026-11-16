import type { Database } from '@atlas/db';
import {
  createEvent,
  derivedEventId,
  publishAll,
  type EventBroker,
  type Subscription,
} from '@atlas/messaging';
import type { EventEnvelope } from '@atlas/types';
import { childTrace, type Logger } from '@atlas/utils';
import {
  findJobById,
  findLatestParsedProfile,
  findLatestParsedProfiles,
  listActiveJobs,
  listCandidateUserIds,
} from './repo/lookups.js';
import { upsertScores, type UpsertScoreInput } from './repo/scores.js';
import { MODEL_VERSION, scoreMatch } from './lib/scorer.js';

export interface WorkerDeps {
  db: Database;
  broker: EventBroker;
  logger: Logger;
}

/**
 * Persists the scores, then publishes one `job.scored` per pair.
 *
 * Delivery is at-least-once, so this whole function can run again for the
 * same triggering event (a retry after a failure part-way, a lease that
 * expired, two drains racing). Both halves are built to be repeatable: the
 * upsert rewrites nothing that did not change, and every `job.scored` gets an
 * id derived from the triggering event and the pair, so the outbox drops the
 * repeat instead of analytics counting it twice. The statements are bounded
 * (a few, whatever the number of pairs); nothing here loops over a pair.
 */
async function scoreAndPublish(
  deps: WorkerDeps,
  envelope: EventEnvelope,
  scores: UpsertScoreInput[],
): Promise<void> {
  if (scores.length === 0) return;

  await upsertScores(deps.db, scores);

  const occurredAt = new Date().toISOString();
  await publishAll(
    deps.broker,
    scores.map((score) =>
      createEvent(
        'job.scored',
        {
          job_id: score.jobId,
          user_id: score.userId,
          score: score.score,
          model_version: score.modelVersion,
        },
        childTrace(envelope.trace, { user_id: score.userId }),
        occurredAt,
        derivedEventId(envelope.event_id, `job.scored:${score.jobId}:${score.userId}`),
      ),
    ),
  );
  deps.logger.info({ event_id: envelope.event_id, scored: scores.length }, 'scored job matches');
}

/**
 * A new resume finished parsing: score it against the current pool of active
 * jobs. Bounded (see `listActiveJobs`); the reads are two queries and the
 * writes are batched, so a full pool is cheap heuristic scoring, not a reason
 * to add fan-out infrastructure yet. Silently does nothing if the user has no
 * parsed resume yet — there's nothing to score against, and that's a normal
 * state, not an error.
 */
async function handleResumeParsed(deps: WorkerDeps, envelope: EventEnvelope<'resume.parsed'>) {
  const { user_id } = envelope.payload;
  const profile = await findLatestParsedProfile(deps.db, user_id);
  if (!profile) return;

  const jobs = await listActiveJobs(deps.db);
  await scoreAndPublish(
    deps,
    envelope,
    jobs.map((job) => {
      const result = scoreMatch(job, profile);
      return {
        jobId: job.job_id,
        userId: user_id,
        score: result.score,
        reasons: result.reasons,
        skillGaps: result.skillGaps,
        modelVersion: MODEL_VERSION,
      };
    }),
  );
}

/**
 * A new job appeared: score it against every candidate who already has a
 * parsed resume, so their recommendations pick it up without waiting for
 * their own next resume upload. The job is read once and the candidates'
 * profiles in one query, not once per candidate.
 */
async function handleJobDiscovered(deps: WorkerDeps, envelope: EventEnvelope<'job.discovered'>) {
  const { job_id } = envelope.payload;
  const job = await findJobById(deps.db, job_id);
  if (!job || !job.is_active) return;

  const userIds = await listCandidateUserIds(deps.db);
  const profiles = await findLatestParsedProfiles(deps.db, userIds);

  const scores: UpsertScoreInput[] = [];
  for (const userId of userIds) {
    const profile = profiles.get(userId);
    if (!profile) continue;
    const result = scoreMatch(job, profile);
    scores.push({
      jobId: job.job_id,
      userId,
      score: result.score,
      reasons: result.reasons,
      skillGaps: result.skillGaps,
      modelVersion: MODEL_VERSION,
    });
  }
  await scoreAndPublish(deps, envelope, scores);
}

export async function registerConsumers(deps: WorkerDeps): Promise<Subscription[]> {
  // `subscribe`'s `eventTypes` filter guarantees only matching envelopes are
  // ever delivered here, so narrowing the generic `EventEnvelope` union to
  // the one type this handler is registered for is safe.
  const resumeSub = await deps.broker.subscribe({
    consumer: 'matching-service.resume-parsed',
    eventTypes: ['resume.parsed'],
    handler: (envelope) => handleResumeParsed(deps, envelope as EventEnvelope<'resume.parsed'>),
  });

  const jobSub = await deps.broker.subscribe({
    consumer: 'matching-service.job-discovered',
    eventTypes: ['job.discovered'],
    handler: (envelope) => handleJobDiscovered(deps, envelope as EventEnvelope<'job.discovered'>),
  });

  return [resumeSub, jobSub];
}
