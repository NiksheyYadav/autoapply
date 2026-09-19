'use client';

import { animate, useInView, useMotionValue, useTransform, motion } from 'framer-motion';
import * as React from 'react';
import { cn } from '../lib/cn.js';
import { DURATION, viewportOnce } from '../motion.js';

export interface StatCounterProps {
  value: number;
  suffix?: string;
  prefix?: string;
  decimals?: number;
  className?: string;
}

/** Counts up from 0 to `value` the first time it scrolls into view. */
export function StatCounter({ value, suffix = '', prefix = '', decimals = 0, className }: StatCounterProps) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, viewportOnce);
  const motionValue = useMotionValue(0);
  const rounded = useTransform(motionValue, (latest) => `${prefix}${latest.toFixed(decimals)}${suffix}`);

  React.useEffect(() => {
    if (!inView) return;
    const controls = animate(motionValue, value, { duration: DURATION.slow + 0.4, ease: 'easeOut' });
    return () => controls.stop();
  }, [inView, value, motionValue]);

  return (
    <motion.span ref={ref} className={cn('font-[var(--font-display)] tabular-nums', className)}>
      {rounded}
    </motion.span>
  );
}
