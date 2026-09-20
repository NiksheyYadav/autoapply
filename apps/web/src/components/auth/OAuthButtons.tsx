'use client';

import { Button } from '@atlas/ui';
import { SERVICE_URLS } from '@/lib/config';

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

/**
 * Full-page redirects to auth-service's OAuth start route, not a client
 * fetch — there's no API gateway/BFF yet (docs/01), so the browser has to
 * make the round trip to the provider itself. See services/auth's
 * oauth-start/oauth-callback routes and /oauth/callback in this app.
 */
export function OAuthButtons() {
  return (
    <div className="flex flex-col gap-3">
      <Button asChild variant="secondary" size="lg">
        <a href={`${SERVICE_URLS.auth}/v1/auth/oauth/google/start`}>
          <GoogleMark />
          Continue with Google
        </a>
      </Button>
      <Button asChild variant="secondary" size="lg">
        <a href={`${SERVICE_URLS.auth}/v1/auth/oauth/microsoft/start`}>
          <MicrosoftMark />
          Continue with Microsoft
        </a>
      </Button>
      <div className="my-1 flex items-center gap-3 text-xs text-[var(--color-ink-faint)]">
        <span className="h-px flex-1 bg-[var(--color-line)]" />
        or continue with email
        <span className="h-px flex-1 bg-[var(--color-line)]" />
      </div>
    </div>
  );
}
