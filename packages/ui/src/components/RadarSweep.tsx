'use client';

import { motion } from 'framer-motion';

const CONTACTS = [
  { top: '30%', left: '62%', delay: 0 },
  { top: '58%', left: '32%', delay: 1.1 },
  { top: '68%', left: '70%', delay: 2.2 },
];

export interface RadarSweepProps {
  size?: number;
  className?: string;
}

/**
 * The invented visual for "this part of the map isn't charted yet" —
 * distinct from RoutePath (a completed journey) and AgentOrbit (a working
 * pipeline): a rotating radar sweep over concentric rings with a few
 * pinging contacts, standing in for "still surveying this area." Used by
 * UnderConstruction and the not-found/error pages.
 */
export function RadarSweep({ size = 240, className }: RadarSweepProps) {
  return (
    <div className={className} style={{ width: size, height: size }} aria-hidden="true">
      <div className="relative h-full w-full overflow-hidden rounded-full border border-[var(--color-line-strong)]">
        <div className="absolute inset-[16%] rounded-full border border-[var(--color-line)]" />
        <div className="absolute inset-[34%] rounded-full border border-[var(--color-line)]" />
        <div className="absolute inset-[52%] rounded-full border border-[var(--color-line)]" />
        <div className="absolute top-1/2 left-0 h-px w-full bg-[var(--color-line)]" />
        <div className="absolute top-0 left-1/2 h-full w-px bg-[var(--color-line)]" />

        <motion.div
          className="absolute inset-0"
          style={{
            background: 'conic-gradient(from 0deg, var(--color-accent) 0deg, transparent 60deg, transparent 360deg)',
            opacity: 0.35,
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
        />

        {CONTACTS.map((contact, index) => (
          <motion.span
            key={index}
            className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-accent)]"
            style={{ top: contact.top, left: contact.left }}
            animate={{ opacity: [0, 1, 0], scale: [0.6, 1.3, 0.6] }}
            transition={{ duration: 2.4, repeat: Infinity, delay: contact.delay, ease: 'easeInOut' }}
          />
        ))}

        <div className="absolute top-1/2 left-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-accent)] shadow-[0_0_16px_2px_var(--color-accent)]" />
      </div>
    </div>
  );
}
