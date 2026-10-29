'use client';

import { Button } from '@atlas/ui';
import Link from 'next/link';
import type { Failure } from '@/lib/errors';

interface ErrorPanelProps {
  failure: Failure;
  onRetry?: () => void;
  /** Where "sign in again" should come back to. Defaults to the console home. */
  signInNext?: string;
  className?: string;
}

/**
 * One place that turns a {@link Failure} into words and a way forward. It never
 * shows server-provided text; only the vetted copy from `describeApiError`.
 */
export function ErrorPanel({ failure, onRetry, signInNext, className }: ErrorPanelProps) {
  const next = signInNext ? `?next=${encodeURIComponent(signInNext)}` : '';
  const showOrganizations = failure.kind === 'not_member' || failure.kind === 'forbidden';

  return (
    <div
      role="alert"
      className={`rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-[var(--color-surface)] p-4 ${className ?? ''}`}
    >
      <p className="text-sm font-medium text-[var(--color-ink)]">{failure.title}</p>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{failure.message}</p>
      {failure.requestId ? (
        <p className="mt-2 font-mono text-xs text-[var(--color-ink-faint)]">Reference: {failure.requestId}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {failure.kind === 'unauthenticated' ? (
          <Button asChild size="sm">
            <Link href={`/login${next}`}>Sign in</Link>
          </Button>
        ) : null}
        {showOrganizations ? (
          <Button asChild size="sm" variant="secondary">
            <Link href="/dashboard/organizations">Choose another organization</Link>
          </Button>
        ) : null}
        {failure.retryable && onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
