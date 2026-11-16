import { cn } from '@atlas/ui';
import * as React from 'react';

/** A native `<select>` styled like `Input` from @atlas/ui (which has no select). Native, so it is keyboard and screen reader accessible by default. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-[var(--color-canvas-raised)] px-3 text-sm text-[var(--color-ink)] outline-none transition-colors focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = 'Select';
