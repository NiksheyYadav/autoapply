'use client';

import { Marquee, fadeUp, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';

/**
 * Fictional employer names, not real companies or logos — Atlas has no
 * signed customers to name-drop yet (jobs are ingested via an admin API,
 * not a live pipeline), so a real-company wall would imply an endorsement
 * or dataset that doesn't exist. This stays illustrative, and says so.
 */
const EMPLOYERS = [
  'Northwind Systems',
  'Fernbank Health',
  'Loop Analytics',
  'Halcyon Robotics',
  'Ridgeline Capital',
  'Corvus Logistics',
  'Meridian Foods',
  'Tidewater Labs',
  'Arclight Energy',
  'Basecamp Materials',
];

export function CompanyMarquee() {
  return (
    <section className="border-y border-[var(--color-line)] bg-[var(--color-canvas-raised)] py-10">
      <motion.p
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
        variants={fadeUp}
        className="mb-6 text-center font-[var(--font-mono)] text-xs uppercase tracking-[0.18em] text-[var(--color-ink-faint)]"
      >
        Roles span every kind of employer
      </motion.p>
      <Marquee durationSeconds={32}>
        <div className="flex items-center gap-10 px-5">
          {EMPLOYERS.map((name) => (
            <span
              key={name}
              className="font-[var(--font-display)] text-lg font-medium whitespace-nowrap text-[var(--color-ink-faint)]"
            >
              {name}
            </span>
          ))}
        </div>
      </Marquee>
      <p className="mt-6 text-center text-xs text-[var(--color-ink-faint)]">
        Illustrative examples — not live Atlas customers.
      </p>
    </section>
  );
}
