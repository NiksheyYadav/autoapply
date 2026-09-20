'use client';

import { useSession } from '@/lib/auth-context';
import { Button } from '@atlas/ui';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function Topbar() {
  const router = useRouter();
  const { user, logout } = useSession();

  async function handleLogout() {
    await logout();
    router.push('/');
  }

  return (
    <header className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-canvas)] px-6 py-4">
      <div>
        <p className="text-sm text-[var(--color-ink-faint)]">Welcome back</p>
        <p className="font-[var(--font-display)] text-lg font-medium text-[var(--color-ink)]">{user?.full_name ?? '—'}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={() => void handleLogout()}>
        <LogOut className="h-4 w-4" />
        Sign out
      </Button>
    </header>
  );
}
