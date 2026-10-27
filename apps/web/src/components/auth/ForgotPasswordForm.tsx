'use client';

import { useSession } from '@/lib/auth-context';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button, Input, Label } from '@atlas/ui';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';

/** `error=link_invalid` comes from app/auth/callback/route.ts when a recovery link can't be exchanged. */
function LinkErrorNotice() {
  const searchParams = useSearchParams();
  if (searchParams.get('error') !== 'link_invalid') return null;
  return (
    <p
      role="alert"
      className="mb-5 rounded-[var(--radius-control)] border border-[var(--color-serious)]/25 bg-[var(--color-serious-soft)] px-4 py-3 text-sm text-[var(--color-serious)]"
    >
      That reset link is invalid or has expired. Enter your email and we&apos;ll send you a new one.
    </p>
  );
}

export function ForgotPasswordForm() {
  const { requestPasswordReset } = useSession();
  const [email, setEmail] = React.useState('');
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      setSentTo(email);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sentTo !== null) {
    return (
      <AuthShell title="Check your email" subtitle="Your reset link is on its way.">
        <div className="flex flex-col gap-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
            <MailCheck className="h-5 w-5 text-[var(--color-accent)]" aria-hidden="true" />
          </div>
          {/* Same wording whether or not the address has an account, so this form can't be used to look up who's registered. */}
          <p role="status" className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
            If there&apos;s an Atlas account for <strong className="font-medium text-[var(--color-ink)]">{sentTo}</strong>, we&apos;ve sent a
            link to reset its password. It can take a minute or two to arrive — check your spam folder too. Open the link in this same
            browser.
          </p>
          <Button asChild size="lg">
            <Link href="/login">Back to sign in</Link>
          </Button>
          <button
            type="button"
            onClick={() => setSentTo(null)}
            className="text-center text-sm text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
          >
            Use a different email
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password" subtitle="Enter your email and we'll send you a link to choose a new one.">
      <React.Suspense fallback={null}>
        <LinkErrorNotice />
      </React.Suspense>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-[var(--color-serious)]">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="lg" disabled={submitting} className="mt-2">
          {submitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-[var(--color-ink-soft)]">
        Remembered it?{' '}
        <Link href="/login" className="font-medium text-[var(--color-accent)]">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
