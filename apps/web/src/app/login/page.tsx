'use client';

import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth-context';
import { AuthShell } from '@/components/auth/AuthShell';
import { OAuthButtons } from '@/components/auth/OAuthButtons';
import { Button, Input, Label } from '@atlas/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  denied: 'You closed or declined the sign-in prompt.',
  state: 'That sign-in link expired. Please try again.',
  provider: "That sign-in provider isn't recognized.",
  oauth_provider_unavailable: "That sign-in provider isn't enabled on this deployment yet.",
  upstream_unavailable: 'The sign-in provider had trouble responding. Please try again.',
  session: 'Something went wrong finishing sign-in. Please try again.',
};

function OAuthErrorNotice() {
  const searchParams = useSearchParams();
  const code = searchParams.get('oauth_error');
  if (!code) return null;
  return (
    <p className="mb-5 rounded-[var(--radius-control)] border border-[var(--color-serious)]/25 bg-[var(--color-serious-soft)] px-4 py-3 text-sm text-[var(--color-serious)]">
      {OAUTH_ERROR_MESSAGES[code] ?? 'Sign-in did not complete. Please try again.'}
    </p>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { login } = useSession();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.push('/dashboard');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to pick up your search where you left it.">
      <React.Suspense fallback={null}>
        <OAuthErrorNotice />
      </React.Suspense>
      <OAuthButtons />
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error ? <p className="text-sm text-[var(--color-serious)]">{error}</p> : null}
        <Button type="submit" size="lg" disabled={submitting} className="mt-2">
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-[var(--color-ink-soft)]">
        New to Atlas?{' '}
        <Link href="/register" className="font-medium text-[var(--color-accent)]">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
