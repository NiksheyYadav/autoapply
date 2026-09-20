import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../lib/cn';

const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', {
  variants: {
    variant: {
      neutral: 'bg-[var(--color-canvas-raised)] text-[var(--color-ink-soft)] border border-[var(--color-line)]',
      accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
      progress: 'bg-[var(--color-progress-soft)] text-[var(--color-progress)]',
      warning: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
      serious: 'bg-[var(--color-serious-soft)] text-[var(--color-serious)]',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
