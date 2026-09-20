'use client';

import { Button, Logo, RadarSweep, fadeUp, staggerContainer } from '@atlas/ui';
import { motion } from 'framer-motion';
import Link from 'next/link';
import type { ReactNode } from 'react';

export interface UnderConstructionProps {
  title?: string;
  message?: string;
  backHref?: string;
  backLabel?: string;
  /** Set for a full standalone page (adds the logo + min-h-screen centering). Off for embedding inline in a dashboard shell. */
  standalone?: boolean;
  children?: ReactNode;
}

/**
 * The shared "not built yet" state — for routes that are real but genuinely
 * unfinished, so a visitor sees an honest, designed placeholder instead of
 * a blank page or a broken one. Also the base for not-found.tsx/error.tsx.
 */
export function UnderConstruction({
  title = "This part of the map isn't charted yet",
  message = "We're still surveying this area. Check back soon — or head somewhere the route is already drawn.",
  backHref = '/',
  backLabel = 'Back to Atlas',
  standalone = true,
  children,
}: UnderConstructionProps) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerContainer}
      className={standalone ? 'flex min-h-screen flex-col items-center justify-center px-6 py-24 text-center' : 'flex flex-col items-center justify-center px-6 py-16 text-center'}
    >
      {standalone ? (
        <motion.div variants={fadeUp} className="mb-10">
          <Link href="/">
            <Logo />
          </Link>
        </motion.div>
      ) : null}

      <motion.div variants={fadeUp}>
        <RadarSweep size={220} className="mx-auto mb-10" />
      </motion.div>

      <motion.h1 variants={fadeUp} className="max-w-md font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)] md:text-3xl">
        {title}
      </motion.h1>
      <motion.p variants={fadeUp} className="mt-3 max-w-sm text-[var(--color-ink-soft)]">
        {message}
      </motion.p>

      {children ? (
        <motion.div variants={fadeUp} className="mt-6">
          {children}
        </motion.div>
      ) : (
        <motion.div variants={fadeUp} className="mt-8">
          <Button asChild variant="secondary">
            <Link href={backHref}>{backLabel}</Link>
          </Button>
        </motion.div>
      )}
    </motion.div>
  );
}
