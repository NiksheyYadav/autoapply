'use client';

import { Logo } from '@atlas/ui';
import { AnimatePresence, motion } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { TransitionLink } from '../transition/TransitionLink';

const LINKS = [
  { href: '#features', label: 'Platform' },
  { href: '#how-it-works', label: 'Agents' },
];

export function NavBar() {
  const [open, setOpen] = React.useState(false);

  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="sticky top-0 z-40 border-b border-white/[0.03] bg-[var(--color-canvas)]/80 backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-10 text-sm font-medium text-[var(--color-ink-faint)] md:flex">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className="transition-colors hover:text-[var(--color-ink)]">
              {link.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-3 sm:gap-6">
          <Link
            href="/login"
            className="hidden text-sm font-medium text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)] sm:block"
          >
            Sign in
          </Link>
          <TransitionLink href="/register" size="sm">
            Get started
          </TransitionLink>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-ink-soft)] transition-colors hover:bg-white/5 hover:text-[var(--color-ink)] md:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-white/[0.03] md:hidden"
          >
            <nav className="flex flex-col gap-1 px-6 py-4 text-sm font-medium text-[var(--color-ink-faint)]">
              {LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="rounded-[var(--radius-control)] px-2 py-2.5 transition-colors hover:bg-white/5 hover:text-[var(--color-ink)]"
                >
                  {link.label}
                </a>
              ))}
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="rounded-[var(--radius-control)] px-2 py-2.5 transition-colors hover:bg-white/5 hover:text-[var(--color-ink)]"
              >
                Sign in
              </Link>
            </nav>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.header>
  );
}
