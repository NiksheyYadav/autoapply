import { describe, expect, it } from 'vitest';
import { failureInfo, failureMessage } from '../src/components/applications/failure-message';

/** Shaped like lib/api.ts's ApiError without importing it. */
function apiError(status: number, code: string, message = 'server detail that must not be shown') {
  return Object.assign(new Error(message), { status, code });
}

describe('failureInfo', () => {
  it('reads status and code from an ApiError-shaped value', () => {
    expect(failureInfo(apiError(409, 'CONFLICT'))).toEqual({ status: 409, code: 'CONFLICT' });
  });

  it('has neither for network errors and non-errors', () => {
    expect(failureInfo(new TypeError('Failed to fetch'))).toEqual({ status: null, code: null });
    expect(failureInfo(new SyntaxError('Unexpected token <'))).toEqual({ status: null, code: null });
    expect(failureInfo(null)).toEqual({ status: null, code: null });
    expect(failureInfo('boom')).toEqual({ status: null, code: null });
  });
});

describe('failureMessage', () => {
  it('never leaks the raw server message', () => {
    for (const scope of ['start-application', 'record-open', 'mark-submitted', 'resume-check'] as const) {
      expect(failureMessage(scope, apiError(400, 'VALIDATION_ERROR'))).not.toContain('server detail');
      expect(failureMessage(scope, apiError(500, 'INTERNAL_ERROR'))).not.toContain('server detail');
    }
  });

  describe('resume check', () => {
    it('explains an unparsed resume (409) and suggests what to do', () => {
      const message = failureMessage('resume-check', apiError(409, 'CONFLICT'));
      expect(message).toMatch(/finished processing/i);
      expect(message).toMatch(/another resume/i);
    });

    it('explains a missing resume and a missing job', () => {
      expect(failureMessage('resume-check', apiError(404, 'RESUME_NOT_FOUND'))).toMatch(/resume/i);
      expect(failureMessage('resume-check', apiError(404, 'JOB_NOT_FOUND'))).toMatch(/job is no longer available/i);
    });
  });

  describe('start application', () => {
    it('explains an unavailable job and a resume that is not ready', () => {
      expect(failureMessage('start-application', apiError(404, 'JOB_NOT_FOUND'))).toMatch(/no longer available/i);
      expect(failureMessage('start-application', apiError(404, 'RESUME_NOT_FOUND'))).toMatch(/resume/i);
    });

    it('explains the one-application-per-job rule', () => {
      expect(failureMessage('start-application', apiError(409, 'CONFLICT'))).toMatch(/already have an application/i);
    });

    it('does not echo the "auto mode unavailable" server text if a 400 ever occurs', () => {
      const message = failureMessage('start-application', apiError(400, 'VALIDATION_ERROR', 'Mode "auto" cannot be used'));
      expect(message).not.toMatch(/auto/i);
    });
  });

  describe('mark submitted', () => {
    it('explains an illegal transition (400) and a vanished application (404)', () => {
      expect(failureMessage('mark-submitted', apiError(400, 'VALIDATION_ERROR'))).toMatch(/current status/i);
      expect(failureMessage('mark-submitted', apiError(404, 'NOT_FOUND'))).toMatch(/couldn't find/i);
    });
  });

  describe('record open', () => {
    it('reassures that the application is unchanged', () => {
      expect(failureMessage('record-open', apiError(500, 'INTERNAL_ERROR'))).toMatch(/unchanged/i);
      expect(failureMessage('record-open', new TypeError('Failed to fetch'))).toMatch(/unchanged/i);
    });
  });

  describe('shared cases', () => {
    it('asks for a new sign-in on 401', () => {
      expect(failureMessage('resume-check', apiError(401, 'UNAUTHENTICATED'))).toMatch(/sign in again/i);
    });

    it('tells the user to wait on a rate limit', () => {
      expect(failureMessage('start-application', apiError(429, 'RATE_LIMITED'))).toMatch(/wait/i);
    });

    it('blames the connection when no response arrived', () => {
      expect(failureMessage('start-application', new TypeError('Failed to fetch'))).toMatch(/check your connection/i);
    });

    it('blames the server on a 5xx', () => {
      expect(failureMessage('mark-submitted', apiError(503, 'UPSTREAM_UNAVAILABLE'))).toMatch(/our side/i);
    });
  });
});
