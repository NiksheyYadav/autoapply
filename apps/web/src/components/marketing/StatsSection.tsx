'use client';

import { StatCounter, fadeUp, staggerContainer, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';

const STATS = [
  { value: 7, suffix: '', label: 'independently deployable services' },
  { value: 100, suffix: '%', label: 'of match scores ship with a reason' },
  { value: 0, suffix: '', label: 'duplicate applications — enforced, not promised' },
  { value: 4, suffix: '', label: 'agents in the pipeline, each doing one job' },
];

export function StatsSection() {
  return (
    <section className="border-y border-[var(--color-line)] bg-[var(--color-canvas-raised)] px-6 py-16">
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
        variants={staggerContainer}
        className="mx-auto grid max-w-5xl grid-cols-2 gap-8 text-center md:grid-cols-4"
      >
        {STATS.map((stat) => (
          <motion.div key={stat.label} variants={fadeUp}>
            <StatCounter value={stat.value} suffix={stat.suffix} className="text-4xl font-medium text-[var(--color-accent)]" />
            <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{stat.label}</p>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
