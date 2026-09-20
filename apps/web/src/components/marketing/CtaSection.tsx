'use client';

import { fadeUp, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { TransitionLink } from '../transition/TransitionLink';

export function CtaSection() {
  return (
    <section className="px-6 py-24">
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
        variants={fadeUp}
        className="relative mx-auto max-w-2xl overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-10 py-16 text-center"
      >
        <div className="absolute inset-0 -z-10" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(229,160,13,0.1), transparent 60%)' }} />
        <h2 className="font-[var(--font-display)] text-3xl font-medium text-[var(--color-ink)] md:text-4xl">
          Stop guessing which jobs are worth your time.
        </h2>
        <p className="mx-auto mt-4 max-w-md text-[var(--color-ink-soft)]">
          Upload a resume, get a plotted route through your search in under a minute.
        </p>
        <TransitionLink href="/register" size="lg" className="mt-8">
          Create your free account
          <ArrowRight className="h-4 w-4" />
        </TransitionLink>
      </motion.div>
    </section>
  );
}
