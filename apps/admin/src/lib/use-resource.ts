'use client';

import * as React from 'react';
import { describeApiError, type Failure, type FailureContext } from './errors';

export interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: Failure | null;
  reload: () => void;
}

/**
 * Small shared fetch-on-mount hook. The fetcher receives an AbortSignal that
 * fires when the inputs change or the component unmounts, so a slow response
 * for a previous search can never overwrite a newer one.
 *
 * While a refetch is in flight the previous `data` stays available (a table
 * does not blank out between pages); on failure `data` is cleared, so stale
 * personal data is never shown next to an error.
 */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: React.DependencyList,
  context: FailureContext = 'generic',
): ResourceState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Failure | null>(null);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetcher(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setData(null);
        setError(describeApiError(cause, context));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // The caller lists the inputs that matter; `fetcher` is a new closure every render.
  }, [...deps, nonce]);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
