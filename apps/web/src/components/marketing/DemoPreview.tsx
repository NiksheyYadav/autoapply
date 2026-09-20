'use client';

import { ShimmerText, fadeUp, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';
import { Play } from 'lucide-react';

/**
 * An honest placeholder, not a fake product demo — it says "coming soon"
 * and means it. The point is the motion/glass treatment, not the content.
 */
export function DemoPreview() {
  return (
    <section className="px-6 py-20">
      <div className="mx-auto max-w-5xl">
        <motion.div initial="hidden" whileInView="visible" viewport={viewportOnce} variants={fadeUp} className="mb-10 text-center">
          <h2 className="font-[var(--font-display)] text-3xl font-medium text-[var(--color-ink)] md:text-4xl">
            See Atlas in motion.
          </h2>
          <p className="mt-2 text-sm text-[var(--color-ink-faint)]">A walkthrough of the pipeline, end to end.</p>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          variants={fadeUp}
          className="atlas-bg-grid group relative aspect-video overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-canvas-raised)] transition-colors duration-700 hover:border-[var(--color-accent)]/40"
        >
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
            <div className="flex h-20 w-20 items-center justify-center rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] shadow-[0_0_40px_-8px_var(--color-accent)] transition-transform duration-500 group-hover:scale-110">
              <Play className="ml-1 h-8 w-8 text-[var(--color-accent)]" fill="currentColor" />
            </div>
            <ShimmerText className="font-[var(--font-display)] text-xl uppercase tracking-widest">
              Demo coming soon
            </ShimmerText>
          </div>

          <div className="absolute top-6 left-6 flex items-center gap-2 font-[var(--font-mono)] text-xs text-[var(--color-ink-faint)]">
            <span className="h-2 w-2 rounded-full bg-[var(--color-serious)]" />
            REC
          </div>
        </motion.div>
      </div>
    </section>
  );
}
