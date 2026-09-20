'use client';

import { useSession } from '@/lib/auth-context';
import { getRecommendations } from '@/lib/services/jobs';
import { listApplications } from '@/lib/services/applications';
import { listReferrals } from '@/lib/services/referrals';
import { listResumes } from '@/lib/services/profile';
import { useResource } from '@/lib/use-resource';
import { Card, CardDescription, CardTitle, Skeleton, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';
import { FileText, SendHorizontal, Search, Users } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

function StatCard({
  href,
  icon: Icon,
  title,
  loading,
  error,
  value,
  hint,
}: {
  href: string;
  icon: typeof FileText;
  title: string;
  loading: boolean;
  error: string | null;
  value: ReactNode;
  hint: string;
}) {
  return (
    <motion.div variants={fadeUp}>
      <Link href={href}>
        <Card interactive>
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
            <Icon className="h-4 w-4 text-[var(--color-accent)]" />
          </div>
          <CardTitle className="text-sm font-medium text-[var(--color-ink-soft)]">{title}</CardTitle>
          {loading ? (
            <Skeleton className="mt-2 h-9 w-16" />
          ) : error ? (
            <p className="mt-1 text-sm text-[var(--color-ink-faint)]">Not reachable</p>
          ) : (
            <p className="mt-1 font-[var(--font-display)] text-3xl font-medium text-[var(--color-ink)]">{value}</p>
          )}
          <CardDescription className="mt-1">{hint}</CardDescription>
        </Card>
      </Link>
    </motion.div>
  );
}

export default function DashboardOverviewPage() {
  const { user, accessToken } = useSession();

  const resumes = useResource(() => listResumes(accessToken!), [accessToken]);
  const jobs = useResource(() => getRecommendations(user!.user_id, accessToken!), [accessToken, user?.user_id]);
  const applications = useResource(() => listApplications(accessToken!), [accessToken]);
  const referrals = useResource(() => listReferrals(accessToken!), [accessToken]);

  const latestAts = resumes.data?.items[0]?.ats_score;

  return (
    <div>
      <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">Your route so far</h1>
      <p className="mt-1 text-[var(--color-ink-soft)]">A quick look at every stage of the pipeline.</p>

      <motion.div
        initial="hidden"
        animate="visible"
        variants={staggerContainer}
        className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <StatCard
          href="/dashboard/resume"
          icon={FileText}
          title="Latest ATS score"
          loading={resumes.loading}
          error={resumes.error}
          value={latestAts !== undefined && latestAts !== null ? Math.round(latestAts) : '—'}
          hint={resumes.data ? `${resumes.data.items.length} resume(s) on file` : 'Upload a resume to start'}
        />
        <StatCard
          href="/dashboard/jobs"
          icon={Search}
          title="Job matches"
          loading={jobs.loading}
          error={jobs.error}
          value={jobs.data?.items.length ?? 0}
          hint="Scored against your resume"
        />
        <StatCard
          href="/dashboard/applications"
          icon={SendHorizontal}
          title="Applications"
          loading={applications.loading}
          error={applications.error}
          value={applications.data?.items.length ?? 0}
          hint="Across every stage"
        />
        <StatCard
          href="/dashboard/referrals"
          icon={Users}
          title="Referral leads"
          loading={referrals.loading}
          error={referrals.error}
          value={referrals.data?.items.length ?? 0}
          hint="Contacts worth a message"
        />
      </motion.div>
    </div>
  );
}
