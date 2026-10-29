'use client';

import { useSession } from '@/lib/auth-context';
import { getRecommendations } from '@/lib/services/jobs';
import { useResource } from '@/lib/use-resource';
import { ProgressRing, Skeleton } from '@atlas/ui';
import { matchPercent } from './job-view-model';

/**
 * How many recommendations to scan for this job's score. There is no
 * per-job score endpoint yet, so the score comes from the user's recommendation
 * list; a job outside it simply has no score to show.
 */
const RECOMMENDATION_SCAN_LIMIT = 50;

/**
 * The job's match score and reasons when matching-service has scored it for
 * this user. Strictly optional: while loading it shows a placeholder, and on
 * failure or no score it renders nothing, so it never blocks the page or
 * invents a number.
 */
export function JobMatchSummary({ jobId }: { jobId: string }) {
  const { user, accessToken } = useSession();
  const recommendations = useResource(
    () => getRecommendations(user!.user_id, accessToken!, RECOMMENDATION_SCAN_LIMIT),
    [accessToken, user?.user_id],
  );

  if (recommendations.loading) {
    return <Skeleton className="h-16 w-16 shrink-0 rounded-full" aria-hidden="true" />;
  }

  const match = recommendations.data?.items.find((item) => item.job.job_id === jobId);
  const percent = match ? matchPercent(match.score) : null;
  if (!match || percent === null) return null;

  return (
    <div className="flex items-start gap-4 sm:flex-col sm:items-end sm:text-right">
      <ProgressRing value={percent} size={72} strokeWidth={7} label="match" />
      {match.reasons.length > 0 ? (
        <div className="max-w-xs sm:max-w-[16rem]">
          <p className="text-xs font-medium text-[var(--color-ink-soft)]">Why it matched</p>
          <ul className="mt-1 space-y-1 text-xs text-[var(--color-ink-faint)]">
            {match.reasons.map((reason, index) => (
              <li key={`${index}:${reason}`}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
