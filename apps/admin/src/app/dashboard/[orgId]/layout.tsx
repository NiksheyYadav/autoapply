'use client';

import { shortId, isOrganizationId } from '@/lib/org';
import Link from 'next/link';
import { notFound, useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const SECTIONS = [
  { slug: '', label: 'Funnel' },
  { slug: 'roster', label: 'Roster' },
  { slug: 'import', label: 'Import' },
  { slug: 'audit', label: 'Audit log' },
] as const;

/**
 * Frame for everything scoped to one organization. The organization id in the
 * address is what the API authorizes against: a non-member gets a 404 from the
 * pages below, a member without a roster role gets a 403. This layout only
 * refuses ids that cannot be organization ids at all.
 */
export default function OrganizationLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ orgId: string }>();
  const pathname = usePathname();
  const orgId = params.orgId;

  if (!isOrganizationId(orgId)) notFound();

  const base = `/dashboard/${orgId}`;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
        <p className="text-[var(--color-ink-soft)]">
          Organization <span className="font-mono text-[var(--color-ink)]">{shortId(orgId)}…</span>
        </p>
        <Link
          href="/dashboard/organizations"
          className="text-[var(--color-ink-soft)] underline underline-offset-2 hover:text-[var(--color-ink)]"
        >
          Switch organization
        </Link>
      </div>

      <nav aria-label="Organization sections" className="-mt-2 overflow-x-auto">
        <ul className="flex min-w-max gap-1 border-b border-[var(--color-line)]">
          {SECTIONS.map((section) => {
            const href = section.slug === '' ? base : `${base}/${section.slug}`;
            const active = pathname === href;
            return (
              <li key={section.slug}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`-mb-px inline-flex h-11 items-center border-b-2 px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                    active
                      ? 'border-[var(--color-accent)] text-[var(--color-ink)]'
                      : 'border-transparent text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {section.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {children}
    </div>
  );
}
