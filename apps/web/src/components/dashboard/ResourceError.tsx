'use client';

import { Button, Card, CardDescription, CardTitle } from '@atlas/ui';
import { RefreshCw } from 'lucide-react';

/**
 * What a dashboard page shows when its data couldn't be loaded. Deliberately
 * generic: the raw error and the name of whichever backend service failed are
 * internals, not something to put in front of a job seeker.
 */
export function ResourceError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <Card className="mt-6" role="alert">
      <CardTitle className="text-base">We couldn&apos;t load {what}</CardTitle>
      <CardDescription className="mt-1">This is usually temporary. Check your connection and try again.</CardDescription>
      <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" />
        Try again
      </Button>
    </Card>
  );
}
