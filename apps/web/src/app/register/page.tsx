'use client';

import { useSession } from '@/lib/auth-context';
import { AuthShell } from '@/components/auth/AuthShell';
import { OAuthButtons } from '@/components/auth/OAuthButtons';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from '@/lib/password';
import { Button, Input, Label } from '@atlas/ui';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

/** Supabase allows one confirmation email per address per minute. */
const RESEND_COOLDOWN_SECONDS = 60;

export default function RegisterPage() {
  const router = useRouter();
  const { register, resendConfirmation } = useSession();
  const [fullName, setFullName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Set once the account exists but email confirmation is still pending.
  const [confirmationSentTo, setConfirmationSentTo] = React.useState<string | null>(null);
  const [resending, setResending] = React.useState(false);
  const [resendNotice, setResendNotice] = React.useState<string | null>(null);
  const [resendError, setResendError] = React.useState<string | null>(null);
  const [cooldown, setCooldown] = React.useState(RESEND_COOLDOWN_SECONDS);

  React.useEffect(() => {
    if (confirmationSentTo === null || cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [confirmationSentTo, cooldown]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }

    setSubmitting(true);
    try {
      const { needsEmailConfirmation } = await register({ email, password, full_name: fullName });
      if (needsEmailConfirmation) {
        // No session yet: /dashboard would only bounce back to /login.
        setCooldown(RESEND_COOLDOWN_SECONDS);
        setPassword('');
        setConfirmationSentTo(email);
        return;
      }
      router.push('/dashboard');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (confirmationSentTo === null) return;
    setResending(true);
    setResendNotice(null);
    setResendError(null);
    try {
      await resendConfirmation(confirmationSentTo);
      setResendNotice("We've sent the link again. It can take a minute or two — check your spam folder too.");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (cause) {
      setResendError(cause instanceof Error ? cause.message : 'Something went wrong. Try again.');
    } finally {
      setResending(false);
    }
  }

  if (confirmationSentTo !== null) {
    return (
      <AuthShell title="Check your email" subtitle="One more step before you can sign in.">
        <div className="flex flex-col gap-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
            <MailCheck className="h-5 w-5 text-[var(--color-accent)]" aria-hidden="true" />
          </div>
          <p className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
            We sent a confirmation link to <strong className="font-medium text-[var(--color-ink)]">{confirmationSentTo}</strong>. Open it to
            confirm your account, then sign in. If it doesn&apos;t arrive within a few minutes, check your spam folder — or, if you
            already have an account with this address, just sign in.
          </p>

          <div role="status" aria-live="polite">
            {resendNotice ? <p className="text-sm text-[var(--color-progress)]">{resendNotice}</p> : null}
          </div>
          {resendError ? (
            <p role="alert" className="text-sm text-[var(--color-serious)]">
              {resendError}
            </p>
          ) : null}

          <Button variant="secondary" size="lg" disabled={resending || cooldown > 0} onClick={() => void handleResend()}>
            {resending ? 'Sending…' : cooldown > 0 ? `Resend email in ${cooldown}s` : 'Resend email'}
          </Button>
          <Button asChild size="lg">
            <Link href="/login">Go to sign in</Link>
          </Button>
          <button
            type="button"
            onClick={() => {
              setConfirmationSentTo(null);
              setResendNotice(null);
              setResendError(null);
            }}
            className="text-center text-sm text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
          >
            Used the wrong email? Start over
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account" subtitle="A resume upload away from your first plotted route.">
      <OAuthButtons />
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div>
          <Label htmlFor="full_name">Full name</Label>
          <Input id="full_name" required autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
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
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            autoComplete="new-password"
            aria-describedby="password-hint"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p id="password-hint" className="mt-1.5 text-xs text-[var(--color-ink-faint)]">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-[var(--color-serious)]">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="lg" disabled={submitting} className="mt-2">
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-[var(--color-ink-soft)]">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-[var(--color-accent)]">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
