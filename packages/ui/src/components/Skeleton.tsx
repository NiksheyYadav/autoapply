import * as React from 'react';
import { cn } from '../lib/cn';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-[var(--radius-control)] bg-[var(--color-line)]', className)}
      {...props}
    />
  );
}
