'use client';

import { useSession } from '@/lib/auth-context';
import { listApplications } from '@/lib/services/applications';
import { statusLabel, statusVariant } from '@/lib/status-badge';
import { useResource } from '@/lib/use-resource';
import { Badge, Card, CardDescription, CardTitle, Skeleton, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';

export default function ApplicationsPage() {
  const { accessToken } = useSession();
  const applications = useResource(() => listApplications(accessToken!), [accessToken]);

  return (
    <div>
      <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Applications</h1>
      <p className="mt-1 text-[var(--color-ink-soft)]">Every submission, tracked from draft to decision.</p>

      {applications.loading ? (
        <div className="mt-6 flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : applications.error ? (
        <Card className="mt-6">
          <CardDescription>Couldn&apos;t reach applications-service: {applications.error}</CardDescription>
        </Card>
      ) : applications.data?.items.length === 0 ? (
        <Card className="mt-6">
          <CardTitle>No applications yet</CardTitle>
          <CardDescription className="mt-1">Apply to a matched job to start tracking it here.</CardDescription>
        </Card>
      ) : (
        <motion.div initial="hidden" animate="visible" variants={staggerContainer} className="mt-6 flex flex-col gap-3">
          {applications.data?.items.map((application) => (
            <motion.div key={application.application_id} variants={fadeUp}>
              <Card className="flex items-center justify-between py-4">
                <div>
                  <p className="text-sm font-medium text-[var(--color-ink)]">Job {application.job_id.slice(0, 8)}</p>
                  <p className="text-xs text-[var(--color-ink-faint)]">
                    {application.mode === 'auto' ? 'Automated' : 'Manual'} · created{' '}
                    {new Date(application.created_at).toLocaleDateString()}
                  </p>
                </div>
                <Badge variant={statusVariant(application.status)}>{statusLabel(application.status)}</Badge>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
