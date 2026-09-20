import * as React from 'react';
import { cn } from '../lib/cn';

/** A muted gray shimmer sweep — for "coming soon"-style copy, never a claim of fact. */
export function ShimmerText({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('atlas-shimmer-text', className)} {...props} />;
}
