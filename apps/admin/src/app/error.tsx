'use client';

import { Logo, RadarSweep } from '@atlas/ui';
import * as React from 'react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-24 text-center">
      <div className="mb-10">
        <Logo />
      </div>
      <RadarSweep size={200} className="mx-auto mb-8" />
      <h1 className="max-w-md font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">
        Something broke along the way
      </h1>
      <p className="mt-3 max-w-sm text-[var(--color-ink-soft)]">That wasn&apos;t supposed to happen.</p>
      <button
        type="button"
        onClick={() => reset()}
        className="mt-8 inline-flex h-11 items-center rounded-full bg-[var(--color-accent)] px-5 text-sm font-medium text-[var(--color-accent-ink)] transition-all hover:brightness-110"
      >
        Try again
      </button>
    </div>
  );
}
