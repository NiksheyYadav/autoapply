import type { ApplicationStatus } from '@atlas/types';

/**
 * Legal forward moves in the application lifecycle (docs/02 § applications).
 * `applications.status` is the folded head of `application_events`, so this
 * map is what keeps that head from ever landing somewhere nonsensical (e.g.
 * `rejected` back to `offer`).
 */
const ALLOWED_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: ['queued', 'withdrawn'],
  queued: ['submitting', 'withdrawn', 'failed'],
  submitting: ['submitted', 'failed'],
  // A failed submission is usually a worker/connector hiccup — requeue it.
  failed: ['queued'],
  submitted: ['acknowledged', 'interviewing', 'rejected', 'withdrawn'],
  acknowledged: ['interviewing', 'rejected', 'withdrawn'],
  interviewing: ['offer', 'rejected', 'withdrawn'],
  offer: ['rejected', 'withdrawn'],
  rejected: [],
  withdrawn: [],
};

export function isValidTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedNextStatuses(from: ApplicationStatus): ApplicationStatus[] {
  return ALLOWED_TRANSITIONS[from];
}
