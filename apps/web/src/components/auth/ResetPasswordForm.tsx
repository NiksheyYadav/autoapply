'use client';

import { useSession } from '@/lib/auth-context';
import { AuthShell } from '@/components/auth/AuthShell';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from '@/lib/password';
import { Button, Input, Label } from '@atlas/ui';
import { CircleCheck } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

/**
 * The page a password-recovery link lands on, via /auth/callback, which has
 * already exchanged the emailed code for a (recovery) session. So "is there a
 * session?" is the whole check for whether the link was good — including
 * `unavailable`, where our own backend is down but the Supabase session, which
 * is all updatePassword needs, is fine.
 */
export function ResetPasswordForm() {
  const { status, updatePassword } = useSession();
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [done, setDone] = React.useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    if (password !== confirmation) {
      setError("The two passwords don't match.");
      return;
    }

    setSubmitting(true);
    try {
      await updatePassword(password);
      setPassword('');
      setConfirmation('');
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AuthShell title="Password updated" subtitle="You're signed in with your new password.">
        <div className="flex flex-col gap-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-progress-soft)]">
            <CircleCheck className="h-5 w-5 text-[var(--color-progress)]" aria-hidden="true" />
          </div>
          <Button asChild size="lg">
            <Link href="/dashboard">Go to your dashboard</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (status === 'loading') {
    return (
      <AuthShell title="Choose a new password" subtitle="Checking your reset link…">
        <div role="status" aria-busy="true" className="text-sm text-[var(--color-ink-faint)]">
          One moment…
        </div>
      </AuthShell>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <AuthShell title="This link isn't valid" subtitle="It may have expired, or already been used.">
        <div className="flex flex-col gap-5">
          <p role="alert" className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
            Reset links work once, for a limited time, and only in the browser you requested them from. Request a new one to continue.
          </p>
          <Button asChild size="lg">
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle={`Pick something at least ${MIN_PASSWORD_LENGTH} characters long.`}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div>
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            autoComplete="new-password"
            aria-describedby="new-password-hint"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p id="new-password-hint" className="mt-1.5 text-xs text-[var(--color-ink-faint)]">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        <div>
          <Label htmlFor="confirm-password">Confirm new password</Label>
          <Input
            id="confirm-password"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-[var(--color-serious)]">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="lg" disabled={submitting} className="mt-2">
          {submitting ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </AuthShell>
  );
}
