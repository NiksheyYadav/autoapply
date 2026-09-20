'use client';

import { Button, GlowText, KineticText, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AgentOrbit } from './AgentOrbit';

export function Hero() {
  return (
    <section className="relative overflow-hidden px-6 pt-24 pb-16 md:pt-32">
      <div className="mx-auto grid max-w-6xl items-center gap-16 lg:grid-cols-2">
        <motion.div variants={staggerContainer} initial="hidden" animate="visible">
          <motion.span
            variants={fadeUp}
            className="mb-8 inline-flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-white/5 px-3 py-1.5 font-[var(--font-mono)] text-xs uppercase tracking-wide text-[var(--color-accent)]"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
            Resume in, referral out
          </motion.span>

          <h1 className="font-[var(--font-display)] text-5xl leading-[1.05] tracking-tight text-[var(--color-ink)] md:text-7xl">
            <KineticText words={['Four', 'agents.']} />
            <br />
            <GlowText className="italic">One search.</GlowText>
          </h1>

          <motion.p variants={fadeUp} className="mt-8 max-w-lg text-lg leading-relaxed text-[var(--color-ink-soft)]">
            Atlas parses your resume, scores every opening against it, tracks each application to the finish line, and
            finds the one person at the company worth messaging first.
          </motion.p>

          <motion.div variants={fadeUp} className="mt-10 flex items-center gap-6">
            <Button asChild size="lg">
              <Link href="/register">
                Start your search
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <span className="text-sm text-[var(--color-ink-faint)]">No credit card required</span>
          </motion.div>
        </motion.div>

        <AgentOrbit />
      </div>
    </section>
  );
}
