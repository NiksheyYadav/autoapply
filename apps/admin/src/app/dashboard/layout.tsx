'use client';

import { useSession } from '@/lib/auth-context';
import { Button, Logo } from '@atlas/ui';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { status, user, role, organizationId, logout } = useSession();

  React.useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-[var(--color-ink-faint)]">
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
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-canvas-raised)] px-4 py-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Logo />
          <span className="hidden font-[var(--font-display)] text-lg font-medium text-[var(--color-ink-faint)] sm:inline">
            Admin
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <span className="hidden max-w-[40vw] truncate text-sm text-[var(--color-ink-soft)] sm:inline">{user?.full_name}</span>
          <Button variant="ghost" size="sm" onClick={() => void handleLogout()}>
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </header>
      {role !== 'admin' && role !== 'owner' ? (
        <div className="border-b border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning)] md:px-6">
          Your account role ({role ?? 'member'}) doesn&apos;t have admin access — the sections below will show
          &quot;not reachable&quot; until an org admin or owner signs in.
        </div>
      ) : !organizationId ? (
        <div className="border-b border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning)] md:px-6">
          This account isn&apos;t attached to an organization, so organization-scoped data can&apos;t be shown.
        </div>
      ) : null}
      <main className="p-4 md:p-6">{children}</main>
    </div>
  );
}
