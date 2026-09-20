'use client';

import { motion } from 'framer-motion';
import * as React from 'react';
import { cn } from '../lib/cn';
import { EASE } from '../motion';

export interface GlowTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
}

/**
 * Atlas's signature kinetic-text treatment — see the `.atlas-glow-text__*`
 * rules in styles/tokens.css for the actual sweep/glow. Meant for one
 * headline moment per screen, not sprinkled everywhere.
 */
export const GlowText = React.forwardRef<HTMLSpanElement, GlowTextProps>(
  ({ className, children, ...props }, ref) => (
    <span ref={ref} className={cn('relative inline-block', className)} {...props}>
      <span aria-hidden="true" className="atlas-glow-text__halo absolute inset-0">
        {children}
      </span>
      <motion.span
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: EASE.standard }}
        className="atlas-glow-text__fg relative"
      >
        {children}
      </motion.span>
    </span>
  ),
);
GlowText.displayName = 'GlowText';
