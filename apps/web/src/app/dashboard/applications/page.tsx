'use client';

import { ApplicationRow } from '@/components/applications/ApplicationRow';
import { buildStatusFilters, filterByStatus, type ApplicationItem } from '@/components/applications/view-model';
import { ResourceError } from '@/components/dashboard/ResourceError';
import { SkeletonGroup } from '@/components/dashboard/SkeletonGroup';
import { useSession } from '@/lib/auth-context';
import { listApplications } from '@/lib/services/applications';
import { useResource } from '@/lib/use-resource';
import { Button, Card, CardDescription, CardTitle, Skeleton } from '@atlas/ui';
import { motion, type Variants } from 'framer-motion';
import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

const PAGE_SIZE = 50;

/** Same reveal as the other lists, but the whole cascade is capped (~0.6s) so a long list doesn't animate for seconds. */
function listVariants(count: number): Variants {
  return {
    hidden: {},
    visible: { transition: { staggerChildren: Math.min(0.08, 0.6 / Math.max(count, 1)), delayChildren: 0.04 } },
  };
}

export default function ApplicationsPage() {
  const { accessToken } = useSession();
  const first = useResource(() => listApplications(accessToken!, { limit: PAGE_SIZE }), [accessToken]);

  // Further pages are appended locally; a fresh first page (retry) discards them.
  const [more, setMore] = React.useState<{ items: ApplicationItem[]; nextCursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [moreFailed, setMoreFailed] = React.useState(false);
  const [filter, setFilter] = React.useState('all');

  React.useEffect(() => {
    setMore(null);
    setMoreFailed(false);
  }, [first.data]);

  const items = React.useMemo(() => [...(first.data?.items ?? []), ...(more?.items ?? [])], [first.data, more]);
  const nextCursor = more ? more.nextCursor : (first.data?.next_cursor ?? null);
  const filters = React.useMemo(() => buildStatusFilters(items), [items]);
  // A filter whose applications are gone after a reload falls back to "All".
  const activeFilter = filters.some((entry) => entry.value === filter) ? filter : 'all';
  const visible = filterByStatus(items, activeFilter);
  const activeLabel = filters.find((entry) => entry.value === activeFilter)?.label ?? 'All';

  async function loadMore() {
    if (!nextCursor || !accessToken || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await listApplications(accessToken, { limit: PAGE_SIZE, cursor: nextCursor });
      setMore((previous) => ({ items: [...(previous?.items ?? []), ...page.items], nextCursor: page.next_cursor }));
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div>
      <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Applications</h1>
      <p className="mt-1 text-[var(--color-ink-soft)]">
        Track the applications you make on employers&apos; sites, from draft to decision. Atlas doesn&apos;t submit
        applications for you.
      </p>

      {first.loading ? (
        <SkeletonGroup label="Loading applications…" className="mt-6 flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </SkeletonGroup>
      ) : first.error ? (
        <ResourceError what="your applications" onRetry={first.reload} />
      ) : items.length === 0 ? (
        <Card className="mt-6">
          <CardTitle>No applications yet</CardTitle>
          <CardDescription className="mt-1">
            Open a job from your matches, check your resume against it, then start an application. You apply on the
            employer&apos;s site and record it here, so this list always shows where you stand.
          </CardDescription>
          <Button asChild variant="secondary" className="mt-5">
            <Link href="/dashboard/jobs">Browse job matches</Link>
          </Button>
        </Card>
      ) : (
        <>
          {filters.length > 2 ? (
            <div role="group" aria-label="Filter applications by status" className="mt-6 flex flex-wrap gap-2">
              {filters.map((entry) => {
                const active = entry.value === activeFilter;
                return (
                  <button
                    key={entry.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(entry.value)}
                    className={
                      active
                        ? 'rounded-full border border-[var(--color-accent)]/50 bg-[var(--color-accent-soft)] px-3.5 py-1.5 text-sm text-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]'
                        : 'rounded-full border border-[var(--color-line)] px-3.5 py-1.5 text-sm text-[var(--color-ink-soft)] hover:border-[var(--color-line-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]'
                    }
                  >
                    {entry.label} <span className="text-[var(--color-ink-faint)]">({entry.count})</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <p role="status" aria-live="polite" className="sr-only">
            {activeFilter === 'all'
              ? `Showing all ${visible.length} applications`
              : `Showing ${visible.length} ${activeLabel.toLowerCase()} applications`}
          </p>

          <motion.ul
            key={activeFilter}
            initial="hidden"
            animate="visible"
            variants={listVariants(visible.length)}
            className="mt-4 flex flex-col gap-3"
          >
            {visible.map((application) => (
              <ApplicationRow key={application.application_id} application={application} />
            ))}
          </motion.ul>

          {nextCursor ? (
            <div className="mt-4">
              <Button variant="secondary" onClick={() => void loadMore()} disabled={loadingMore} aria-busy={loadingMore}>
                {loadingMore ? (
                  <>
                    <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading…
                  </>
                ) : (
                  'Show older applications'
                )}
              </Button>
              {moreFailed ? (
                <p role="alert" className="mt-2 text-sm text-[var(--color-serious)]">
                  We couldn&apos;t load more applications. Check your connection and try again.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
