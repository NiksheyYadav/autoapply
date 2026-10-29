import type { ApplicationStatus } from '@atlas/types';

/**
 * Legal forward moves in the application lifecycle (docs/02 § applications).
 * `applications.status` is the folded head of `application_events`, so this
 * map is what keeps that head from ever landing somewhere nonsensical (e.g.
 * `rejected` back to `offer`).
 */
const ALLOWED_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  // `draft -> submitted` is the assisted-apply path: the user applied on the
  // employer's own site and reports it. Without it a manual application would
  // have to be walked through `queued` and `submitting`, which are states a
  // submission worker owns and which nothing consumes today.
  draft: ['queued', 'submitted', 'withdrawn'],
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

/**
 * Note carried by the one status-less event an application owner can record:
 * "I opened the employer's apply page" (assisted apply). It is a marker, not a
 * lifecycle move — see {@link isOpenedApplyLinkMarker}.
 */
export const OPENED_APPLY_LINK_NOTE = 'opened_apply_link';

/**
 * True for `draft -> draft` with the {@link OPENED_APPLY_LINK_NOTE} note. The
 * trail (`application_events`) only records status changes, and a same-status
 * "move" is rejected everywhere else, so this is a narrow, explicit exception:
 * only while the application is still a draft, and only with exactly this note.
 * The route additionally restricts it to the application's owner.
 */
export function isOpenedApplyLinkMarker(
  from: ApplicationStatus,
  to: ApplicationStatus,
  note: string | undefined,
): boolean {
  return from === 'draft' && to === 'draft' && note === OPENED_APPLY_LINK_NOTE;
}
