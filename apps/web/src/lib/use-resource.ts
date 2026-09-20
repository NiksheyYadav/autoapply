'use client';

import * as React from 'react';
import { ApiError } from './api';

export interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Small shared fetch-on-mount hook so each dashboard page (resume, jobs,
 * applications, referrals, messages) doesn't repeat the same loading/error
 * boilerplate, and so one service being down only breaks its own card
 * instead of the whole page (each page calls this independently).
 */
export function useResource<T>(fetcher: () => Promise<T>, deps: React.DependencyList): ResourceState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiError ? cause.message : 'Could not reach this service.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [...deps, nonce]);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}
