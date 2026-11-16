import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The page itself is a client component, so its title lives here. Indexing is
// already switched off for all of /dashboard in the parent layout.
export const metadata: Metadata = { title: 'Applications' };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
