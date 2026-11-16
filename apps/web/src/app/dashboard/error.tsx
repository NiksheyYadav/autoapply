'use client';

import { Button, Card, CardDescription, CardTitle } from '@atlas/ui';
import Link from 'next/link';
import * as React from 'react';

/**
 * Error boundary for any dashboard page. Sits inside the dashboard layout, so
 * the sidebar and topbar stay put and only the page content is replaced.
 */
export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card className="mx-auto mt-6 max-w-lg" role="alert">
      <CardTitle>Something went wrong</CardTitle>
      <CardDescription className="mt-1">
        This page hit an unexpected problem. It&apos;s usually temporary — try again, or head back to your overview.
      </CardDescription>
      <div className="mt-5 flex items-center gap-3">
        <Button onClick={() => retry()}>Try again</Button>
        <Button asChild variant="secondary">
          <Link href="/dashboard">Back to overview</Link>
        </Button>
      </div>
    </Card>
  );
}
