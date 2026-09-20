'use client';

import { useSession } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import * as React from 'react';

export default function RootPage() {
  const router = useRouter();
  const { status } = useSession();

  React.useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  return <div className="flex min-h-screen items-center justify-center text-sm text-[var(--color-ink-faint)]">Loading…</div>;
}
