'use client';

import { useSession } from '@/lib/auth-context';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { Topbar } from '@/components/dashboard/Topbar';
import { Button } from '@atlas/ui';
import { useRouter } from 'next/navigation';
import * as React from 'react';

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { status, retry, logout } = useSession();

  React.useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  if (status === 'unavailable') {
    return (
      <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">We can&apos;t reach Atlas right now</h1>
        <p className="max-w-sm text-sm text-[var(--color-ink-soft)]">
          You&apos;re still signed in. This is usually temporary — give it a moment and try again.
        </p>
        <div className="flex items-center gap-3">
          <Button onClick={() => void retry()}>Try again</Button>
          <Button
            variant="ghost"
            onClick={() => {
              void logout().then(() => router.push('/'));
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  if (status !== 'authenticated') {
    return (
      <div
        role="status"
        aria-busy={status === 'loading'}
        className="flex min-h-screen items-center justify-center text-sm text-[var(--color-ink-faint)]"
      >
        {status === 'loading' ? 'Loading your route…' : 'Redirecting to sign in…'}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Topbar />
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
