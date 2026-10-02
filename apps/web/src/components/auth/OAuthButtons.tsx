'use client';

import { Button } from '@atlas/ui';
import * as React from 'react';
import { useSession, type OAuthProvider } from '@/lib/auth-context';

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.12-.85 2.07-1.81 2.7v2.26h2.92c1.71-1.57 2.69-3.89 2.69-6.6Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.92v2.33A8.997 8.997 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.73A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.19.29-1.73V4.94H.92A8.997 8.997 0 0 0 0 9c0 1.45.35 2.83.92 4.06l3.05-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A8.997 8.997 0 0 0 .92 4.94l3.05 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
      <rect x="0" y="0" width="8.5" height="8.5" fill="#F25022" />
      <rect x="9.5" y="0" width="8.5" height="8.5" fill="#7FBA00" />
      <rect x="0" y="9.5" width="8.5" height="8.5" fill="#00A4EF" />
      <rect x="9.5" y="9.5" width="8.5" height="8.5" fill="#FFB900" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Supabase's own hosted OAuth flow (redirect to the provider, back through
 * /auth/callback) — replaces the old full-page redirects to auth-service's
 * now-deleted oauth-start route. Microsoft's Supabase provider id is
 * 'azure', not 'microsoft'.
 */
export function OAuthButtons() {
  const { signInWithOAuth } = useSession();
  const [pending, setPending] = React.useState<OAuthProvider | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function handleClick(provider: OAuthProvider) {
    setError(null);
    setPending(provider);
    try {
      await signInWithOAuth(provider);
      // On success the browser navigates away to the provider — no need to clear `pending`.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Try again.');
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Button variant="secondary" size="lg" disabled={pending !== null} onClick={() => void handleClick('google')}>
        <GoogleMark />
        {pending === 'google' ? 'Redirecting…' : 'Continue with Google'}
      </Button>
      <Button variant="secondary" size="lg" disabled={pending !== null} onClick={() => void handleClick('azure')}>
        <MicrosoftMark />
        {pending === 'azure' ? 'Redirecting…' : 'Continue with Microsoft'}
      </Button>
      <Button variant="secondary" size="lg" disabled={pending !== null} onClick={() => void handleClick('github')}>
        <GitHubMark />
        {pending === 'github' ? 'Redirecting…' : 'Continue with GitHub'}
      </Button>
      {error ? <p className="text-sm text-[var(--color-serious)]">{error}</p> : null}
      <div className="my-1 flex items-center gap-3 text-xs text-[var(--color-ink-faint)]">
        <span className="h-px flex-1 bg-[var(--color-line)]" />
        or continue with email
        <span className="h-px flex-1 bg-[var(--color-line)]" />
      </div>
    </div>
  );
}
