'use client';

import { useSession } from '@/lib/auth-context';
import { getRecommendations } from '@/lib/services/jobs';
import { useResource } from '@/lib/use-resource';
import { Badge, Card, CardDescription, CardTitle, ProgressRing, Skeleton, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';

export default function JobsPage() {
  const { user, accessToken } = useSession();
  const jobs = useResource(() => getRecommendations(user!.user_id, accessToken!), [accessToken, user?.user_id]);

  return (
    <div>
      <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Job matches</h1>
      <p className="mt-1 text-[var(--color-ink-soft)]">Scored by matching-service against your most recent resume.</p>

      {jobs.loading ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : jobs.error ? (
        <Card className="mt-6">
          <CardDescription>Couldn&apos;t reach jobs-service: {jobs.error}</CardDescription>
        </Card>
      ) : jobs.data?.items.length === 0 ? (
        <Card className="mt-6">
          <CardTitle>No matches yet</CardTitle>
          <CardDescription className="mt-1">
            Scores appear once matching-service has processed your resume against active jobs.
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
              <Card interactive className="flex h-full gap-4">
                <ProgressRing value={score * 100} size={64} strokeWidth={6} />
                <div className="flex-1">
                  <CardTitle>{job.title}</CardTitle>
                  <CardDescription className="mt-1">
                    {job.location ?? 'Location unspecified'} · {job.remote_type}
                  </CardDescription>
                  {reasons.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-[var(--color-ink-faint)]">
                      {reasons.slice(0, 2).map((reason) => (
                        <li key={reason}>{reason}</li>
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
                </div>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
