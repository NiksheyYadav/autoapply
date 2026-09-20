'use client';

import { useSession } from '@/lib/auth-context';
import { Button } from '@atlas/ui';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { MobileNav } from './MobileNav';

export function Topbar() {
  const router = useRouter();
  const { user, logout } = useSession();

  async function handleLogout() {
    await logout();
    router.push('/');
  }

  return (
    <header className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] bg-[var(--color-canvas)] px-4 py-4 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <MobileNav />
        <div className="min-w-0">
          <p className="text-sm text-[var(--color-ink-faint)]">Welcome back</p>
          <p className="truncate font-[var(--font-display)] text-lg font-medium text-[var(--color-ink)]">
            {user?.full_name ?? '—'}
          </p>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => void handleLogout()}>
        <LogOut className="h-4 w-4" />
        <span className="hidden sm:inline">Sign out</span>
      </Button>
    </header>
  );
}
