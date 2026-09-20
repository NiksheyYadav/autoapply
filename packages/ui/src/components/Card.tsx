'use client';

import { motion } from 'framer-motion';
import * as React from 'react';
import { cn } from '../lib/cn';
import { EASE } from '../motion';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Lifts and gains a stronger border on hover — for cards that are also links/buttons. */
  interactive?: boolean;
}

export function Card({ className, interactive = false, children, ...props }: CardProps) {
  if (!interactive) {
    return (
      <div
        className={cn('rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-6', className)}
        {...props}
      >
        {children}
      </div>
    );
  }

  return (
    <motion.div
      whileHover={{ y: -3 }}
      transition={{ duration: 0.25, ease: EASE.standard }}
      className={cn(
        'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-6 transition-[border-color,box-shadow] duration-300 hover:border-[var(--color-accent)]/30 hover:shadow-[0_0_50px_-16px_var(--color-accent)]',
        className,
      )}
      {...(props as React.ComponentProps<typeof motion.div>)}
    >
      {children}
    </motion.div>
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('font-[var(--font-display)] text-lg font-medium text-[var(--color-ink)]', className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-[var(--color-ink-soft)]', className)} {...props} />;
}
