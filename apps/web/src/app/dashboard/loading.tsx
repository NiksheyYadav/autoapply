import { Card, Skeleton } from '@atlas/ui';
import { SkeletonGroup } from '@/components/dashboard/SkeletonGroup';

/** Shown while a dashboard route segment is loading; mirrors a page's heading + cards. */
export default function DashboardLoading() {
  return (
    <SkeletonGroup label="Loading…">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-3 h-4 w-72 max-w-full" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="mt-3 h-4 w-24" />
            <Skeleton className="mt-3 h-9 w-16" />
          </Card>
        ))}
      </div>
    </SkeletonGroup>
  );
}
