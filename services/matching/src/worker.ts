import type { Database } from '@atlas/db';
import { createEvent, type EventBroker, type Subscription } from '@atlas/messaging';
import type { EventEnvelope } from '@atlas/types';
import { childTrace, type Logger } from '@atlas/utils';
import { findLatestParsedProfile, findJobById, listActiveJobs, listCandidateUserIds } from './repo/lookups.js';
import { upsertScore } from './repo/scores.js';
import { MODEL_VERSION, scoreMatch } from './lib/scorer.js';

export interface WorkerDeps {
  db: Database;
  broker: EventBroker;
  logger: Logger;
}

/**
 * Scores one job for one user and publishes `job.scored`. Silently does
 * nothing if the user has no parsed resume yet — there's nothing to score
 * against, and that's a normal state, not an error.
 */
async function scoreAndPublish(deps: WorkerDeps, jobId: string, userId: string, trace: EventEnvelope['trace']) {
  const profile = await findLatestParsedProfile(deps.db, userId);
  if (!profile) return;
  const job = await findJobById(deps.db, jobId);
  if (!job || !job.is_active) return;

  const result = scoreMatch(job, profile);
  await upsertScore(deps.db, {
    jobId: job.job_id,
    userId,
    score: result.score,
    reasons: result.reasons,
    skillGaps: result.skillGaps,
    modelVersion: MODEL_VERSION,
  });

  await deps.broker.publish(
    createEvent(
      'job.scored',
      { job_id: job.job_id, user_id: userId, score: result.score, model_version: MODEL_VERSION },
      childTrace(trace, { user_id: userId }),
    ),
  );
}

/**
 * A new resume finished parsing: score it against the current pool of active
 * jobs. Bounded (see `listActiveJobs`) and processed sequentially — this is
 * cheap heuristic scoring, not a reason to add fan-out infrastructure yet.
 */
async function handleResumeParsed(deps: WorkerDeps, envelope: EventEnvelope<'resume.parsed'>) {
  const { user_id } = envelope.payload;
  const jobs = await listActiveJobs(deps.db);
  for (const job of jobs) {
    await scoreAndPublish(deps, job.job_id, user_id, envelope.trace);
  }
}

/**
 * A new job appeared: score it against every candidate who already has a
 * parsed resume, so their recommendations pick it up without waiting for
 * their own next resume upload.
 */
async function handleJobDiscovered(deps: WorkerDeps, envelope: EventEnvelope<'job.discovered'>) {
  const { job_id } = envelope.payload;
  const userIds = await listCandidateUserIds(deps.db);
  for (const userId of userIds) {
    await scoreAndPublish(deps, job_id, userId, envelope.trace);
  }
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
