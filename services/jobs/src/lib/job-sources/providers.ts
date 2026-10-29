import { BOARD_TOKEN_PATTERN, type JobBoardProvider } from '@atlas/types';
import { ashbyAdapter } from './ashby.js';
import type { ProviderAdapter } from './common.js';
import { greenhouseAdapter } from './greenhouse.js';
import { leverAdapter } from './lever.js';

export const PROVIDER_ADAPTERS: Readonly<Record<JobBoardProvider, ProviderAdapter>> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
};

/** Raised for a board token that must not be spliced into a URL. */
export class InvalidBoardTokenError extends Error {
  constructor() {
    super('board token is not a valid identifier');
    this.name = 'InvalidBoardTokenError';
  }
}

/**
 * The one place a request URL for a source is built: the provider's fixed
 * origin plus a validated token, nothing else. The token is checked again here
 * (it was validated on the way in, and the table has a CHECK constraint too)
 * because this is the last line before the network, and the result is verified
 * to still point at the provider's own origin.
 */
export function buildSourceUrl(provider: JobBoardProvider, boardToken: string): URL {
  if (!BOARD_TOKEN_PATTERN.test(boardToken)) throw new InvalidBoardTokenError();
  const adapter = PROVIDER_ADAPTERS[provider];
  const url = adapter.buildUrl(boardToken);
  if (url.origin !== adapter.origin || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new InvalidBoardTokenError();
  }
  return url;
}
