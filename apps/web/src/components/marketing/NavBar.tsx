'use client';

import { Button } from '@atlas/ui';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Compass } from 'lucide-react';

export function NavBar() {
  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[var(--color-canvas)]/85 backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2 font-[var(--font-display)] text-lg font-medium text-[var(--color-ink)]">
          <Compass className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={2.25} />
          Atlas
        </Link>
        <nav className="hidden items-center gap-8 text-sm text-[var(--color-ink-soft)] md:flex">
          <a href="#how-it-works" className="transition-colors hover:text-[var(--color-ink)]">
            How it works
          </a>
          <a href="#features" className="transition-colors hover:text-[var(--color-ink)]">
            Features
          </a>
        </nav>
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/register">Get started</Link>
          </Button>
        </div>
      </div>
    </motion.header>
  );
}
