'use client';

import { Button, GlowText, RoutePath, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AmbientField } from './AmbientField';

export function Hero() {
  return (
    <section className="relative overflow-hidden px-6 pt-20 pb-16 md:pt-28">
      <AmbientField />
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="mx-auto max-w-3xl text-center"
      >
        <motion.span
          variants={fadeUp}
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-1.5 font-[var(--font-mono)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]"
        >
          Resume in, referral out
        </motion.span>
        <motion.h1
          variants={fadeUp}
          className="font-[var(--font-display)] text-4xl font-medium leading-[1.08] text-[var(--color-ink)] md:text-6xl"
        >
          Your job search, <GlowText className="italic">plotted</GlowText> and worked for you.
        </motion.h1>
        <motion.p variants={fadeUp} className="mx-auto mt-6 max-w-xl text-lg text-[var(--color-ink-soft)]">
          Atlas parses your resume, scores every opening against it, tracks each application to the finish line, and
          finds the one person at the company worth messaging first.
        </motion.p>
        <motion.div variants={fadeUp} className="mt-9 flex items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/register">
              Start mapping your search
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <a href="#how-it-works">See how it works</a>
          </Button>
        </motion.div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.3 }}
        className="mx-auto mt-16 max-w-3xl rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-8 shadow-[0_24px_60px_-24px_rgb(var(--shadow-color)/0.18)]"
      >
        <RoutePath waypoints={['Resume parsed', 'Matched & scored', 'Applied', 'Referral found']} />
      </motion.div>
    </section>
  );
}
