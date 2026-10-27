'use client';

import { useSession } from '@/lib/auth-context';
import { getRecommendations } from '@/lib/services/jobs';
import { useResource } from '@/lib/use-resource';
import { ResourceError } from '@/components/dashboard/ResourceError';
import { SkeletonGroup } from '@/components/dashboard/SkeletonGroup';
import { Badge, Card, CardDescription, CardTitle, ProgressRing, Skeleton, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';
import Link from 'next/link';

export default function JobsPage() {
  const { user, accessToken } = useSession();
  const jobs = useResource(() => getRecommendations(user!.user_id, accessToken!), [accessToken, user?.user_id]);

  return (
    <div>
      <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Job matches</h1>
      <p className="mt-1 text-[var(--color-ink-soft)]">Scored against your most recent resume.</p>

      {jobs.loading ? (
        <SkeletonGroup label="Loading job matches…" className="mt-6 grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </SkeletonGroup>
      ) : jobs.error ? (
        <ResourceError what="your job matches" onRetry={jobs.reload} />
      ) : jobs.data?.items.length === 0 ? (
        <Card className="mt-6">
          <CardTitle>No matches yet</CardTitle>
          <CardDescription className="mt-1">
            Matches appear once you&apos;ve uploaded a resume and it has been scored against open roles. Check back shortly.
          </CardDescription>
        </Card>
      ) : (
        <motion.div
          initial="hidden"
          animate="visible"
          variants={staggerContainer}
          className="mt-6 grid gap-4 sm:grid-cols-2"
        >
          {jobs.data?.items.map(({ job, score, reasons }) => (
            <motion.div key={job.job_id} variants={fadeUp}>
              <Card interactive className="relative flex h-full gap-4 focus-within:border-[var(--color-accent)]/60">
                <ProgressRing value={score * 100} size={64} strokeWidth={6} />
                <div className="min-w-0 flex-1">
                  <CardTitle>
                    {/* The overlay makes the whole card the link target while the title stays the accessible name. */}
                    <Link
                      href={`/dashboard/jobs/${job.job_id}`}
                      className="after:absolute after:inset-0 after:rounded-[var(--radius-card)] focus-visible:outline-none"
                    >
                      {job.title}
                    </Link>
                  </CardTitle>
                  <CardDescription className="mt-1">
                    {job.location ?? 'Location unspecified'} · {job.remote_type}
                  </CardDescription>
                  {reasons.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-[var(--color-ink-faint)]">
                      {reasons.slice(0, 2).map((reason, index) => (
                        <li key={`${index}:${reason}`}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                  {job.skills.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {job.skills.slice(0, 6).map((skill) => (
                        <Badge key={skill} variant="neutral">
                          {skill}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <p className="mt-3 text-xs font-medium text-[var(--color-accent)]">View details</p>
                </div>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
