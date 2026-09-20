'use client';

import { motion } from 'framer-motion';

const CONTOURS = [
  'M-20,120 C120,80 220,160 340,110 C460,60 560,140 700,90 C780,60 850,100 900,80',
  'M-20,200 C100,170 240,230 360,190 C480,150 600,220 720,180 C800,160 850,190 900,170',
  'M-20,300 C140,260 260,330 380,290 C500,250 620,310 740,270 C800,250 850,280 900,260',
];

const DOTS: [number, number][] = [
  [12, 20],
  [28, 55],
  [46, 15],
  [62, 48],
  [78, 22],
  [88, 60],
  [35, 78],
  [55, 82],
];

/**
 * The hero's backdrop: faint topographic contour lines and drifting
 * waypoint dots, echoing RoutePath's map motif rather than a generic radial
 * gradient blob. Two soft glows (accent + progress) breathe slowly behind
 * it — the same two signal colors GlowText uses, so the page reads as one
 * consistent light source rather than several unrelated effects.
 */
export function AmbientField() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <motion.div
        className="absolute -top-32 -right-24 h-[420px] w-[420px] rounded-full"
        style={{ background: 'radial-gradient(circle, var(--color-accent-soft) 0%, transparent 70%)' }}
        animate={{ scale: [1, 1.08, 1], opacity: [0.7, 0.9, 0.7] }}
        transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -bottom-40 -left-32 h-[380px] w-[380px] rounded-full"
        style={{ background: 'radial-gradient(circle, var(--color-progress-soft) 0%, transparent 70%)' }}
        animate={{ scale: [1, 1.1, 1], opacity: [0.5, 0.75, 0.5] }}
        transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
      />
      <svg className="absolute inset-0 h-full w-full opacity-[0.35]" viewBox="0 0 800 500" preserveAspectRatio="none">
        {CONTOURS.map((d, index) => (
          <path key={index} d={d} fill="none" stroke="var(--color-line-strong)" strokeWidth={1} />
        ))}
      </svg>
      {DOTS.map(([x, y], index) => (
        <motion.span
          key={index}
          className="absolute h-1.5 w-1.5 rounded-full bg-[var(--color-line-strong)]"
          style={{ left: `${x}%`, top: `${y}%` }}
          animate={{ opacity: [0.3, 0.8, 0.3] }}
          transition={{ duration: 3 + (index % 4), repeat: Infinity, ease: 'easeInOut', delay: index * 0.4 }}
        />
      ))}
    </div>
  );
}
