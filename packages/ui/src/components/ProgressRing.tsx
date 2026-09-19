'use client';

import { motion, useInView } from 'framer-motion';
import * as React from 'react';
import { cn } from '../lib/cn.js';
import { DURATION, EASE, viewportOnce } from '../motion.js';

export interface ProgressRingProps {
  /** 0–100. */
  value: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
  className?: string;
}

function colorFor(value: number): string {
  if (value >= 70) return 'var(--color-progress)';
  if (value >= 40) return 'var(--color-warning)';
  return 'var(--color-serious)';
}

/** Draws itself in on first view — used for ATS and match scores. */
export function ProgressRing({ value, size = 96, strokeWidth = 8, label, className }: ProgressRingProps) {
  const ref = React.useRef<SVGSVGElement>(null);
  const inView = useInView(ref, viewportOnce);
  const clamped = Math.min(100, Math.max(0, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const color = colorFor(clamped);

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)}>
      <svg ref={ref} width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--color-line)" strokeWidth={strokeWidth} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: inView ? circumference * (1 - clamped / 100) : circumference }}
          transition={{ duration: DURATION.slow, ease: EASE.standard }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-[var(--font-display)] text-xl font-medium text-[var(--color-ink)]">{Math.round(clamped)}</span>
        {label ? <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</span> : null}
      </div>
    </div>
  );
}
