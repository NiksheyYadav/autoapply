'use client';

import { Logo, RoutePath, fadeUp } from '@atlas/ui';
import { motion } from 'framer-motion';
import Link from 'next/link';
import type { ReactNode } from 'react';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen md:grid-cols-2">
      <div className="flex flex-col justify-center px-6 py-16 md:px-16">
        <motion.div initial="hidden" animate="visible" variants={fadeUp} className="mx-auto w-full max-w-sm">
          <Link href="/" className="mb-8 inline-block">
            <Logo />
          </Link>
          <h1 className="font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">{title}</h1>
          <p className="mt-1.5 text-sm text-[var(--color-ink-soft)]">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </motion.div>
      </div>
      <div className="hidden items-center justify-center border-l border-[var(--color-line)] bg-[var(--color-canvas-raised)] p-16 md:flex">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2, duration: 0.6 }} className="max-w-md">
          <RoutePath waypoints={['Resume parsed', 'Matched & scored', 'Applied', 'Referral found']} />
          <p className="mt-6 text-center text-sm text-[var(--color-ink-faint)]">
            One route, four steps, zero manual spreadsheet tracking.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
