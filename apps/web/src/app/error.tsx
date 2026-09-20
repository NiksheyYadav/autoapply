'use client';

import { Button } from '@atlas/ui';
import { UnderConstruction } from '@/components/UnderConstruction';
import * as React from 'react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <UnderConstruction
      title="Something broke along the way"
      message="That wasn't supposed to happen. The route's still there — try again, or head back to safe ground."
    >
      <div className="flex items-center justify-center gap-3">
        <Button onClick={() => reset()}>Try again</Button>
        <Button asChild variant="secondary">
          <a href="/">Back to Atlas</a>
        </Button>
      </div>
    </UnderConstruction>
  );
}
