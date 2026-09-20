'use client';

import { useSession } from '@/lib/auth-context';
import { RoutePath } from '@atlas/ui';
import { useRouter } from 'next/navigation';
import * as React from 'react';

/**
 * auth-service's oauth-callback route redirects here with tokens in the URL
 * *fragment* (never the query string) — a fragment is never sent to any
 * server, only readable by this page's own JS, which is the closest this
 * client-only app (no BFF/cookie session yet, see auth-context.tsx) gets to
 * not putting a bearer token on the wire a second time.
 */
export default function OAuthCallbackPage() {
  const router = useRouter();
  const { completeOAuthLogin } = useSession();
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    const expires_in = params.get('expires_in');

    if (!access_token || !refresh_token || !expires_in) {
      setError(true);
      return;
    }

    // Clear the fragment immediately so the tokens don't linger in history/address bar.
    window.history.replaceState(null, '', window.location.pathname);

    completeOAuthLogin({
      access_token,
      refresh_token,
      expires_in: Number(expires_in),
      token_type: 'Bearer',
    })
      .then(() => router.replace('/dashboard'))
      .catch(() => setError(true));
  }, [completeOAuthLogin, router]);

  React.useEffect(() => {
    if (error) router.replace('/login?oauth_error=session');
  }, [error, router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <div className="w-full max-w-xs">
        <RoutePath waypoints={['Signed in']} />
      </div>
      <p className="text-sm text-[var(--color-ink-soft)]">Finishing sign-in…</p>
    </div>
  );
}
