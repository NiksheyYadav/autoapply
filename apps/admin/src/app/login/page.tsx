'use client';

import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth-context';
import { Button, Card, Input, Label, fadeUp } from '@atlas/ui';
import { motion } from 'framer-motion';
import { Compass } from 'lucide-react';
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
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-canvas-raised)] px-6">
      <motion.div initial="hidden" animate="visible" variants={fadeUp} className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2 font-[var(--font-display)] text-lg font-medium text-[var(--color-ink)]">
          <Compass className="h-5 w-5 text-[var(--color-accent)]" />
          Atlas Admin
        </div>
        <Card>
          <p className="mb-6 text-center text-sm text-[var(--color-ink-soft)]">
            Sign in with an org admin or owner account to view usage and application activity.
          </p>
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
            <Button type="submit" size="lg" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>
      </motion.div>
    </div>
  );
}
