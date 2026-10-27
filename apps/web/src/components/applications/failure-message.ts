/**
 * Turns a failed request into the sentence a job seeker should read. The raw
 * `ApiError.message` is a server string ("Cannot move an application from
 * \"draft\" to ..."), and a network failure is a bare `TypeError`, so neither
 * is shown directly.
 *
 * Duck-typed on `{ status, code }` instead of `instanceof ApiError` so it can
 * be unit tested without pulling in the fetch wrapper.
 */

export type FailureScope = 'start-application' | 'record-open' | 'mark-submitted' | 'resume-check';

export interface FailureInfo {
  /** HTTP status, or null when the request never got a response (offline, DNS, CORS, non-JSON gateway page). */
  status: number | null;
  code: string | null;
}

export function failureInfo(cause: unknown): FailureInfo {
  if (typeof cause === 'object' && cause !== null) {
    const { status, code } = cause as { status?: unknown; code?: unknown };
    return {
      status: typeof status === 'number' ? status : null,
      code: typeof code === 'string' ? code : null,
    };
  }
  return { status: null, code: null };
}

const OFFLINE = "We couldn't reach Atlas just now. Check your connection and try again.";
const SIGNED_OUT = 'Your session has expired. Please sign in again.';
const RATE_LIMITED = "You're doing that too quickly. Wait a few seconds and try again.";

export function failureMessage(scope: FailureScope, cause: unknown): string {
  const { status, code } = failureInfo(cause);

  if (status === 401 || code === 'UNAUTHENTICATED' || code === 'SESSION_EXPIRED') return SIGNED_OUT;
  if (status === 429 || code === 'RATE_LIMITED') return RATE_LIMITED;

  switch (scope) {
    case 'start-application':
      if (code === 'JOB_NOT_FOUND') return "This job is no longer available, so an application can't be started for it.";
      if (code === 'RESUME_NOT_FOUND') return "That resume isn't ready to use. Choose a resume that has finished processing.";
      if (code === 'CONFLICT') return 'You already have an application for this job.';
      if (status !== null && status < 500) return "We couldn't start this application. Refresh the page and try again.";
      break;
    case 'mark-submitted':
      if (code === 'NOT_FOUND') return "We couldn't find this application. Refresh the page and try again.";
      if (status !== null && status < 500) {
        return "This application can't be marked as submitted from its current status. Refresh the page to see where it stands.";
      }
      break;
    case 'record-open':
      return "We couldn't note that you opened the employer's page. Your application is unchanged, and you can still apply and mark it submitted.";
    case 'resume-check':
      if (status === 409 || code === 'CONFLICT') {
        return "This resume hasn't finished processing, so it can't be checked yet. Try again in a moment, or choose another resume.";
      }
      if (code === 'RESUME_NOT_FOUND') return "We couldn't find that resume. Refresh the page and choose another one.";
      if (code === 'JOB_NOT_FOUND') return 'This job is no longer available to check against.';
      if (status !== null && status < 500) return "We couldn't run the check. Refresh the page and try again.";
      break;
  }

  return status === null ? OFFLINE : 'Something went wrong on our side. Please try again in a moment.';
}
