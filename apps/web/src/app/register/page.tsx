'use client';

import { useSession } from '@/lib/auth-context';
import { AuthShell } from '@/components/auth/AuthShell';
import { OAuthButtons } from '@/components/auth/OAuthButtons';
import { Button, Input, Label } from '@atlas/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useSession();
  const [fullName, setFullName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [confirmationSentTo, setConfirmationSentTo] = React.useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { needsEmailConfirmation } = await register({ email, password, full_name: fullName });
      if (needsEmailConfirmation) {
        setConfirmationSentTo(email);
      } else {
        router.push('/dashboard');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmationSentTo) {
    return (
      <AuthShell title="Check your email" subtitle="One more step before your first plotted route.">
        <p className="text-sm text-[var(--color-ink-soft)]">
          We sent a confirmation link to <span className="font-medium text-[var(--color-ink)]">{confirmationSentTo}</span>.
          Open it on this device to finish creating your account.
        </p>
        <p className="mt-6 text-center text-sm text-[var(--color-ink-soft)]">
          Already confirmed?{' '}
          <Link href="/login" className="font-medium text-[var(--color-accent)]">
            Sign in
          </Link>
        </p>
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
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">At least 12 characters.</p>
        </div>
        {error ? <p className="text-sm text-[var(--color-serious)]">{error}</p> : null}
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
