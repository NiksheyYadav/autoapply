'use client';

import { useSession } from '@/lib/auth-context';
import { Button, Logo } from '@atlas/ui';
import { LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, user, logout } = useSession();

  // Sign-in guard. Only the path is carried to the sign-in page: nothing in
  // this app's URLs is personal, and nothing sensitive should ever be added.
  React.useEffect(() => {
    if (status === 'unauthenticated') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  if (status !== 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-[var(--color-ink-faint)]" role="status">
        {status === 'loading' ? 'Loading…' : 'Redirecting to sign in…'}
      </div>
    );
  }

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-[var(--color-accent)] focus:px-4 focus:py-2 focus:text-sm focus:text-[var(--color-accent-ink)]"
      >
        Skip to content
      </a>
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-canvas-raised)] px-4 py-4 md:px-6">
        <Link href="/dashboard" className="flex min-w-0 items-center gap-2" aria-label="Atlas Admin home">
          <Logo />
          <span className="hidden font-[var(--font-display)] text-lg font-medium text-[var(--color-ink-faint)] sm:inline">
            Admin
          </span>
        </Link>
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <span className="hidden max-w-[40vw] truncate text-sm text-[var(--color-ink-soft)] sm:inline">{user?.full_name}</span>
          <Button variant="ghost" size="sm" onClick={() => void handleLogout()}>
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
            <span className="sr-only sm:hidden">Sign out</span>
          </Button>
        </div>
      </header>
      <main id="main" className="p-4 md:p-6">
        {children}
      </main>
      <footer className="px-4 pb-8 pt-2 text-center text-xs text-[var(--color-ink-faint)] md:px-6">
        Atlas platform operators:{' '}
        <Link href="/dashboard/platform" className="underline underline-offset-2 hover:text-[var(--color-ink-soft)]">
          platform-wide model health
        </Link>
        . Not specific to any organization.
      </footer>
    </div>
  );
}
