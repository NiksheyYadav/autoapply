'use client';

import { Button, fadeUp, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export function CtaSection() {
  return (
    <section className="px-6 py-24">
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
        variants={fadeUp}
        className="mx-auto max-w-2xl rounded-[var(--radius-card)] bg-[var(--color-ink)] px-10 py-14 text-center"
      >
        <h2 className="font-[var(--font-display)] text-3xl font-medium text-[var(--color-canvas)] md:text-4xl">
          Stop guessing which jobs are worth your time.
        </h2>
        <p className="mx-auto mt-4 max-w-md text-[var(--color-ink-faint)]">
          Upload a resume, get a plotted route through your search in under a minute.
        </p>
        <Button asChild size="lg" className="mt-8">
          <Link href="/register">
            Create your free account
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </motion.div>
    </section>
  );
}
