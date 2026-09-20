'use client';

import { Button, Logo } from '@atlas/ui';
import { motion } from 'framer-motion';
import Link from 'next/link';

export function NavBar() {
  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[var(--color-canvas)]/80 backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-10 text-sm font-medium text-[var(--color-ink-faint)] md:flex">
          <a href="#features" className="transition-colors hover:text-[var(--color-ink)]">
            Platform
          </a>
          <a href="#how-it-works" className="transition-colors hover:text-[var(--color-ink)]">
            Agents
          </a>
        </nav>
        <div className="flex items-center gap-6">
          <Link href="/login" className="text-sm font-medium text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]">
            Sign in
          </Link>
          <Button asChild size="sm">
            <Link href="/register">Get started</Link>
          </Button>
        </div>
      </div>
    </motion.header>
  );
}
