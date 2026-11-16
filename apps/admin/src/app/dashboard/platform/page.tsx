'use client';

import { ErrorPanel } from '@/components/ErrorPanel';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { requireAccessToken } from '@/lib/api';
import { useSession } from '@/lib/auth-context';
import { getMetrics } from '@/lib/services/learning';
import { useResource } from '@/lib/use-resource';
import { Badge, Card, CardDescription, CardTitle, Skeleton } from '@atlas/ui';
import Link from 'next/link';

/**
 * Platform-wide matching-model health. This is cross-tenant: it aggregates
 * every user's scores and applications, so learning-service answers 403 to
 * everyone but Atlas platform operators. It is kept out of the organization
 * console on purpose, and a 403 here is an expected answer, not a fault.
 */
export default function PlatformPage() {
  const { getAccessToken } = useSession();

  const metrics = useResource(
    async (signal) => getMetrics(await requireAccessToken(getAccessToken), signal),
    [getAccessToken],
    'platform',
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader title="Platform model health" />

      <Notice tone="warning" title="Platform-wide data, not your organization">
        Everything on this page covers all Atlas users across all organizations. It is for the people who operate
        Atlas, and it says nothing about your students or your university. For your roster, go to{' '}
        <Link href="/dashboard" className="underline underline-offset-2">
          the organization console
        </Link>
        .
      </Notice>

      <Card>
        <CardTitle>Matching model health</CardTitle>
        <CardDescription className="mt-1 mb-4">
          Whether higher match scores actually get applied to more, per model version.
        </CardDescription>
        {metrics.loading ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : metrics.error ? (
          metrics.error.kind === 'forbidden' ? (
            <Notice title={metrics.error.title}>{metrics.error.message}</Notice>
          ) : (
            <ErrorPanel failure={metrics.error} onRetry={metrics.reload} signInNext="/dashboard/platform" />
          )
        ) : metrics.data && metrics.data.models.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {metrics.data.models.map((model) => (
              <li
                key={model.model_version}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--color-ink)]">{model.model_version}</p>
                  <p className="text-xs text-[var(--color-ink-faint)]">
                    {model.applied_samples} applied · {model.not_applied_samples} skipped
                  </p>
                </div>
                <Badge variant={model.lift !== null && model.lift > 0 ? 'progress' : 'serious'}>
                  {model.lift !== null
                    ? `${model.lift > 0 ? '+' : ''}${(model.lift * 100).toFixed(0)} lift`
                    : 'insufficient data'}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-ink-faint)]">No scored models yet.</p>
        )}
      </Card>
    </div>
  );
}
