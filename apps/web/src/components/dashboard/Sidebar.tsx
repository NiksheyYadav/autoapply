'use client';

import { Logo, cn } from '@atlas/ui';
import { motion } from 'framer-motion';
import {
  FileText,
  LayoutDashboard,
  MailPlus,
  Plug,
  Search,
  SendHorizontal,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/resume', label: 'Resume', icon: FileText },
  { href: '/dashboard/jobs', label: 'Jobs', icon: Search },
  { href: '/dashboard/applications', label: 'Applications', icon: SendHorizontal },
  { href: '/dashboard/referrals', label: 'Referrals', icon: Users },
  { href: '/dashboard/messages', label: 'Messages', icon: MailPlus },
  { href: '/dashboard/connectors', label: 'Connectors', icon: Plug },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-canvas-raised)] p-5 md:flex">
      <Link href="/" className="mb-8 px-2">
        <Logo size={26} />
      </Link>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'relative flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-sm font-medium transition-colors',
                active ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]',
              )}
            >
              {active ? (
                <motion.span
                  layoutId="sidebar-active"
                  className="absolute inset-0 rounded-[var(--radius-control)] border border-[var(--color-accent)]/20 bg-[var(--color-accent-soft)]"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                />
              ) : null}
              <item.icon className="relative z-10 h-4 w-4" strokeWidth={2} />
              <span className="relative z-10">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
