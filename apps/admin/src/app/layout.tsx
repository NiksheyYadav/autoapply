import type { Metadata } from 'next';
import { DM_Serif_Display, Fragment_Mono, Inter } from 'next/font/google';
import { CursorGlow, Spotlight } from '@atlas/ui';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/auth-context';
import './globals.css';

const dmSerifDisplay = DM_Serif_Display({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['400'],
  style: ['normal', 'italic'],
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['300', '400', '500', '600', '700'],
});

/** The "coordinate readout" register — matches apps/web; see packages/ui's tokens.css. */
const fragmentMono = Fragment_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400'],
});

export const metadata: Metadata = {
  title: 'Atlas Admin',
  description: 'University pilot console for Atlas: student roster, CSV import and export, and the student funnel.',
  // A staff console full of student data: nothing here belongs in a search index.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${dmSerifDisplay.variable} ${inter.variable} ${fragmentMono.variable}`} suppressHydrationWarning>
      <body className="atlas-bg-grid relative min-h-screen selection:bg-[var(--color-accent-soft)] selection:text-[var(--color-ink)]">
        <Spotlight />
        <CursorGlow />
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
