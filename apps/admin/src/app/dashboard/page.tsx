'use client';

import { useSession } from '@/lib/auth-context';
import { getSummary } from '@/lib/services/analytics';
import { listOrganizationApplications } from '@/lib/services/applications';
import { getMetrics } from '@/lib/services/learning';
import { statusLabel, statusVariant } from '@/lib/status-badge';
import { useResource } from '@/lib/use-resource';
import { Badge, Card, CardDescription, CardTitle, Skeleton, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';

function EventBar({ label, count, max }: { label: string; count: number; max: number }) {
  const width = max > 0 ? Math.max((count / max) * 100, 4) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-[var(--color-ink)]">{label}</span>
        <span className="tabular-nums text-[var(--color-ink-faint)]">{count}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-canvas-raised)]">
        <motion.div
          className="h-full rounded-full bg-[var(--color-accent)]"
          initial={{ width: 0 }}
          animate={{ width: `${width}%` }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { accessToken } = useSession();

  const summary = useResource(() => getSummary(accessToken!, 30), [accessToken]);
  const metrics = useResource(() => getMetrics(accessToken!), [accessToken]);
  const applications = useResource(() => listOrganizationApplications(accessToken!), [accessToken]);

  const maxCount = summary.data ? Math.max(...summary.data.events.map((e) => e.count), 1) : 1;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Organization overview</h1>
        <p className="mt-1 text-[var(--color-ink-soft)]">Usage over the last 30 days, application activity, and platform model health.</p>
      </div>

      <motion.div initial="hidden" animate="visible" variants={staggerContainer} className="grid gap-6 md:grid-cols-2">
        <motion.div variants={fadeUp}>
          <Card>
            <CardTitle>Activity (30d)</CardTitle>
            <CardDescription className="mt-1 mb-4">Events recorded by analytics-service for this organization.</CardDescription>
            {summary.loading ? (
              <div className="flex flex-col gap-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : summary.error ? (
              <p className="text-sm text-[var(--color-ink-faint)]">Not reachable: {summary.error}</p>
            ) : summary.data && summary.data.events.length > 0 ? (
              <div className="flex flex-col gap-3">
                {summary.data.events
                  .sort((a, b) => b.count - a.count)
                  .map((event) => (
                    <EventBar key={event.event_type} label={event.event_type} count={event.count} max={maxCount} />
                  ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">No activity recorded yet.</p>
            )}
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card>
            <CardTitle>Matching model health</CardTitle>
            <CardDescription className="mt-1 mb-4">
              Platform-wide, not org-specific — whether higher scores actually get applied to more.
            </CardDescription>
            {metrics.loading ? (
              <div className="flex flex-col gap-3">
                {[0, 1].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : metrics.error ? (
              <p className="text-sm text-[var(--color-ink-faint)]">Not reachable: {metrics.error}</p>
            ) : metrics.data && metrics.data.models.length > 0 ? (
              <div className="flex flex-col gap-3">
                {metrics.data.models.map((model) => (
                  <div key={model.model_version} className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 py-2.5">
                    <div>
                      <p className="text-sm font-medium text-[var(--color-ink)]">{model.model_version}</p>
                      <p className="text-xs text-[var(--color-ink-faint)]">
                        {model.applied_samples} applied · {model.not_applied_samples} skipped
                      </p>
                    </div>
                    <Badge variant={model.lift !== null && model.lift > 0 ? 'progress' : 'serious'}>
                      {model.lift !== null ? `${model.lift > 0 ? '+' : ''}${(model.lift * 100).toFixed(0)} lift` : 'insufficient data'}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">No scored models yet.</p>
            )}
          </Card>
        </motion.div>
      </motion.div>

      <Card>
        <CardTitle>Applications</CardTitle>
        <CardDescription className="mt-1 mb-4">Every application submitted by a member of this organization.</CardDescription>
        {applications.loading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : applications.error ? (
          <p className="text-sm text-[var(--color-ink-faint)]">Not reachable: {applications.error}</p>
        ) : applications.data?.items.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-faint)]">No applications yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                  <th className="py-2 pr-4">User</th>
                  <th className="py-2 pr-4">Job</th>
                  <th className="py-2 pr-4">Mode</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Created</th>
                </tr>
              </thead>
              <tbody>
                {applications.data?.items.map((application) => (
                  <tr key={application.application_id} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-ink-soft)]">{application.user_id.slice(0, 8)}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-ink-soft)]">{application.job_id.slice(0, 8)}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-ink-soft)]">{application.mode}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={statusVariant(application.status)}>{statusLabel(application.status)}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-ink-faint)]">{new Date(application.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
