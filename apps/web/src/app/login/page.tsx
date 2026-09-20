'use client';

import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth-context';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button, Input, Label } from '@atlas/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

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
