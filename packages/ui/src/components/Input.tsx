import * as React from 'react';
import { cn } from '../lib/cn.js';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3.5 text-sm text-[var(--color-ink)] outline-none transition-colors placeholder:text-[var(--color-ink-faint)] focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent-soft)]',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label ref={ref} className={cn('mb-1.5 block text-sm font-medium text-[var(--color-ink)]', className)} {...props} />
  ),
);
Label.displayName = 'Label';
