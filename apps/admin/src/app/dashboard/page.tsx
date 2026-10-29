'use client';

import { useSession } from '@/lib/auth-context';
import { resolveLanding } from '@/lib/org';
import { useRouter } from 'next/navigation';
import * as React from 'react';

/**
 * `/dashboard` has no content of its own. It sends the user into the
 * organization their sign-in names (when that claim carries an owner/admin
 * role), or to the organization chooser, which explains the situation when
 * there is nothing to open.
 */
export default function DashboardIndexPage() {
  const router = useRouter();
  const { organizationId, role } = useSession();

  React.useEffect(() => {
    const landing = resolveLanding({ organizationId, role });
    router.replace(landing.kind === 'open' ? `/dashboard/${landing.organizationId}` : '/dashboard/organizations');
  }, [organizationId, role, router]);

  return (
    <div className="flex min-h-[40vh] items-center justify-center text-sm text-[var(--color-ink-faint)]" role="status">
      Opening your organization…
    </div>
  );
}
