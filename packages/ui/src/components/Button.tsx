'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { motion } from 'framer-motion';
import * as React from 'react';
import { cn } from '../lib/cn.js';
import { springs } from '../motion.js';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-canvas)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-sm hover:brightness-105',
        secondary: 'bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-line)] hover:border-[var(--color-line-strong)]',
        ghost: 'text-[var(--color-ink)] hover:bg-[var(--color-surface)]',
        outline: 'border border-[var(--color-line-strong)] text-[var(--color-ink)] hover:bg-[var(--color-surface)]',
        destructive: 'bg-[var(--color-serious)] text-white hover:brightness-105',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-5 text-sm',
        lg: 'h-12 px-7 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart'>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    if (asChild) {
      // Slot can't take motion props, so a link-as-button skips the press animation.
      return <Slot className={cn(buttonVariants({ variant, size }), className)} {...props} />;
    }
    return (
      <motion.button
        ref={ref}
        whileTap={{ scale: 0.97 }}
        transition={springs.press}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
