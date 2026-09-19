'use client';

import { motion } from 'framer-motion';
import * as React from 'react';
import { cn } from '../lib/cn.js';
import { EASE } from '../motion.js';

export interface RoutePathProps {
  className?: string;
  /** Labels shown at each waypoint, in order along the path. */
  waypoints?: string[];
}

const PATH = 'M20,180 C90,180 90,60 170,60 C250,60 250,150 330,150 C390,150 400,40 470,40';
const POINTS: [number, number][] = [
  [20, 180],
  [170, 60],
  [330, 150],
  [470, 40],
];

/**
 * The signature motif: a route drawing itself across a map, waypoints
 * landing as it goes. This is Atlas's own visual signature, not a stock
 * hero illustration — it's meant to be recognizable as this product.
 */
export function RoutePath({ className, waypoints = [] }: RoutePathProps) {
  return (
    <svg viewBox="0 0 500 220" className={cn('w-full', className)} fill="none" aria-hidden="true">
      <motion.path
        d={PATH}
        stroke="var(--color-line-strong)"
        strokeWidth={2}
        strokeDasharray="1 8"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 1.6, ease: EASE.standard }}
      />
      <motion.path
        d={PATH}
        stroke="var(--color-accent)"
        strokeWidth={3}
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.6, ease: EASE.standard }}
      />
      {POINTS.map(([x, y], index) => (
        <g key={index}>
          <motion.circle
            cx={x}
            cy={y}
            r={index === POINTS.length - 1 ? 8 : 6}
            fill={index === POINTS.length - 1 ? 'var(--color-accent)' : 'var(--color-surface)'}
            stroke="var(--color-accent)"
            strokeWidth={2}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.3 + index * 0.35, ease: EASE.responsive }}
            style={{ transformOrigin: `${x}px ${y}px` }}
          />
          {index === POINTS.length - 1 ? (
            <motion.circle
              cx={x}
              cy={y}
              r={8}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2}
              initial={{ scale: 1, opacity: 0.6 }}
              animate={{ scale: 2.2, opacity: 0 }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut', delay: 1.4 }}
              style={{ transformOrigin: `${x}px ${y}px` }}
            />
          ) : null}
          {waypoints[index] ? (
            <motion.text
              x={x}
              y={y - 16}
              textAnchor="middle"
              className="fill-[var(--color-ink-soft)] font-[var(--font-sans)]"
              fontSize={12}
              initial={{ opacity: 0, y: y - 10 }}
              animate={{ opacity: 1, y: y - 16 }}
              transition={{ duration: 0.4, delay: 0.5 + index * 0.35 }}
            >
              {waypoints[index]}
            </motion.text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}
