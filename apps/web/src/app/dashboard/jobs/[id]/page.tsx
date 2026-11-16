'use client';

import { ResourceError } from '@/components/dashboard/ResourceError';
import { SkeletonGroup } from '@/components/dashboard/SkeletonGroup';
import { JobDetail } from '@/components/jobs/JobDetail';
import { useSession } from '@/lib/auth-context';
import { getJob } from '@/lib/services/jobs';
import { useResource } from '@/lib/use-resource';
import type { Job } from '@atlas/types';
import { Button, Card, CardDescription, CardTitle, Skeleton } from '@atlas/ui';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JobLookup = { found: true; job: Job } | { found: false };

/**
 * An unknown id (404) and a malformed one (400) both mean "no such job" to the
 * user; anything else (network, 5xx) is a real failure and is rethrown so the
 * page offers a retry instead of claiming the job doesn't exist.
 */
async function lookUpJob(jobId: string, accessToken: string): Promise<JobLookup> {
  if (!UUID_PATTERN.test(jobId)) return { found: false };
  try {
    const { job } = await getJob(jobId, accessToken);
    return { found: true, job };
  } catch (cause) {
    const status = (cause as { status?: unknown } | null)?.status;
    if (status === 404 || status === 400) return { found: false };
    throw cause;
  }
}

function BackLink() {
  return (
    <Link
      href="/dashboard/jobs"
      className="inline-flex items-center gap-1.5 rounded text-sm text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Back to job matches
    </Link>
  );
}

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const { accessToken } = useSession();
  const lookup = useResource(() => lookUpJob(jobId, accessToken!), [accessToken, jobId]);

  return (
    <div>
      <BackLink />

      {lookup.loading ? (
        <SkeletonGroup label="Loading job…" className="mt-4 flex max-w-4xl flex-col gap-6">
          <Card>
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="mt-3 h-4 w-1/2" />
            <Skeleton className="mt-5 h-6 w-full" />
          </Card>
          <Skeleton className="h-48 w-full" />
        </SkeletonGroup>
      ) : lookup.error ? (
        <ResourceError what="this job" onRetry={lookup.reload} />
      ) : lookup.data?.found ? (
        <JobDetail job={lookup.data.job} />
      ) : (
        <Card className="mt-6 max-w-lg" role="alert">
          <CardTitle>This job isn&apos;t available</CardTitle>
          <CardDescription className="mt-1">
            It may have been removed, or the link may be wrong. Your other matches are still there.
          </CardDescription>
          <Button asChild variant="secondary" className="mt-5">
            <Link href="/dashboard/jobs">See your job matches</Link>
          </Button>
        </Card>
      )}
    </div>
  );
}
