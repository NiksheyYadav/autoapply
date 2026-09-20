import type { Metadata } from 'next';
import { Fragment_Mono, Fraunces, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/auth-context';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
});

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['400', '500', '600', '700', '800'],
});

/** The "coordinate readout" register — see packages/ui's tokens.css for where it's used. */
const fragmentMono = Fragment_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400'],
});

export const metadata: Metadata = {
  title: 'Atlas — job search, automated',
  description: 'Atlas parses your resume, finds jobs worth applying to, and helps you get a referral before you hit submit.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${manrope.variable} ${fragmentMono.variable}`} suppressHydrationWarning>
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
