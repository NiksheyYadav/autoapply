import { ApiError, INVALID_RESPONSE_CODE, NETWORK_ERROR_CODE } from './api';

/**
 * What a failure means to the person looking at the screen. The UI branches on
 * `kind` (which recovery action to offer), never on message text.
 */
export type FailureKind =
  | 'unauthenticated'
  | 'not_member'
  | 'forbidden'
  | 'rate_limited'
  | 'too_large'
  | 'unsupported_media'
  | 'validation'
  | 'conflict'
  | 'network'
  | 'server'
  | 'invalid_response'
  | 'unknown';

export type FailureContext = 'generic' | 'roster' | 'funnel' | 'import' | 'export' | 'platform';

export interface Failure {
  kind: FailureKind;
  title: string;
  message: string;
  /** Trying the same thing again can succeed (after a wait, for a rate limit). */
  retryable: boolean;
  requestId?: string;
  retryAfterSeconds?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Header names echoed by the server are the user's own text; keep them short and single-line. */
function displayName(name: string): string {
  return name.replace(/\s+/g, ' ').slice(0, 40);
}

function listColumns(names: string[]): string {
  return names.slice(0, 10).map(displayName).join(', ');
}

function validationMessage(context: FailureContext, error: ApiError): string {
  const details = isRecord(error.details) ? error.details : undefined;
  if (context === 'import' && details) {
    const missing = stringList(details.missing_columns);
    if (missing.length > 0) {
      return `The header row is missing required column(s): ${listColumns(missing)}.`;
    }
    const unknown = stringList(details.unknown_columns);
    if (unknown.length > 0) {
      return `The header row has column(s) Atlas does not recognize: ${listColumns(unknown)}.`;
    }
    if (positiveInt(details.record) !== undefined) {
      return 'The file could not be read as CSV. Check for a quote (") that is never closed or that sits in the middle of a value.';
    }
  }
  if (context === 'import') {
    return 'The server could not use this file. Check that it matches the template and try again.';
  }
  return 'The server rejected this request. Reload the page and try again.';
}

function tooLargeMessage(context: FailureContext, error: ApiError): string {
  const details = isRecord(error.details) ? error.details : undefined;
  const maxRows = positiveInt(details?.max_rows);
  if (context === 'export') {
    return maxRows
      ? `An export can contain at most ${maxRows.toLocaleString('en-US')} students. Narrow the roster with search or filters and export again.`
      : 'This export is too large. Narrow the roster with search or filters and export again.';
  }
  if (context === 'import') {
    return maxRows
      ? `An import can contain at most ${maxRows.toLocaleString('en-US')} rows. Split the file into smaller files and import them one at a time.`
      : 'This file is too large to import. Split it into smaller files and import them one at a time.';
  }
  return 'The request was too large.';
}

/** Maps anything thrown by the API client to copy and a recovery path. Never echoes untrusted server text except as a fallback. */
export function describeApiError(error: unknown, context: FailureContext = 'generic'): Failure {
  if (!(error instanceof ApiError)) {
    return {
      kind: 'unknown',
      title: 'Something went wrong',
      message: 'An unexpected error occurred. Try again.',
      retryable: true,
    };
  }

  const base = { requestId: error.requestId, retryAfterSeconds: error.retryAfterSeconds };

  if (error.code === NETWORK_ERROR_CODE || error.status === 0) {
    return {
      ...base,
      kind: 'network',
      title: 'Could not reach Atlas',
      message: 'Check your internet connection and try again.',
      retryable: true,
    };
  }

  if (error.code === INVALID_RESPONSE_CODE) {
    return {
      ...base,
      kind: 'invalid_response',
      title: 'Unexpected response',
      message:
        'Atlas answered, but not in the format this console expects. Reload the page; if it keeps happening, contact Atlas support and quote the reference below.',
      retryable: true,
    };
  }

  switch (error.status) {
    case 401:
      return {
        ...base,
        kind: 'unauthenticated',
        title: 'Your session has expired',
        message: 'Sign in again to continue.',
        retryable: false,
      };
    case 403:
      if (context === 'platform') {
        return {
          ...base,
          kind: 'forbidden',
          title: 'Available to Atlas platform operators only',
          message:
            'This view covers the whole platform, not one organization, so it is limited to the people who operate Atlas. Your account does not have that access. Nothing is wrong with your university console.',
          retryable: false,
        };
      }
      return {
        ...base,
        kind: 'forbidden',
        title: 'This account cannot use the roster console here',
        message:
          'The roster console needs an owner or admin role in a university organization. Ask the person who set up your Atlas pilot to check your role.',
        retryable: false,
      };
    case 404:
      return {
        ...base,
        kind: 'not_member',
        title: 'Organization not found for your account',
        message:
          'Either this organization does not exist or you are not a member of it. Atlas does not say which, so that one organization cannot learn another one exists.',
        retryable: false,
      };
    case 409:
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
        return {
          ...base,
          kind: 'conflict',
          title: 'This import was already submitted with different contents',
          message: 'Choose the file again to start a fresh import.',
          retryable: false,
        };
      }
      return {
        ...base,
        kind: 'conflict',
        title: 'Another request is still in progress',
        message: 'Wait a moment and try again.',
        retryable: true,
      };
    case 413:
      return {
        ...base,
        kind: 'too_large',
        title: context === 'export' ? 'Too many students to export at once' : 'This file is too large',
        message: tooLargeMessage(context, error),
        retryable: false,
      };
    case 415:
      return {
        ...base,
        kind: 'unsupported_media',
        title: 'File type not accepted',
        message: 'Upload a .csv file saved as CSV (comma separated).',
        retryable: false,
      };
    case 429: {
      const wait = error.retryAfterSeconds;
      return {
        ...base,
        kind: 'rate_limited',
        title: 'Too many requests',
        message:
          wait !== undefined && wait > 0
            ? `Imports and exports are rate limited. Wait about ${wait} second${wait === 1 ? '' : 's'} and try again.`
            : 'Imports and exports are rate limited. Wait a minute and try again.',
        retryable: true,
      };
    }
    default:
      break;
  }

  if (error.status === 400) {
    return {
      ...base,
      kind: 'validation',
      title: context === 'import' ? 'This file could not be imported' : 'Request not accepted',
      message: validationMessage(context, error),
      retryable: false,
    };
  }

  if (error.status >= 500) {
    return {
      ...base,
      kind: 'server',
      title: 'Atlas had a problem',
      message: 'This is not caused by anything you did. Try again in a moment.',
      retryable: true,
    };
  }

  return {
    ...base,
    kind: 'unknown',
    title: 'Something went wrong',
    message: 'The request failed. Try again.',
    retryable: true,
  };
}
