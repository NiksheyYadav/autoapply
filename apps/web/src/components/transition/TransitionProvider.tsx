'use client';

import { motion } from 'framer-motion';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

interface TransitionContextValue {
  navigate: (href: string, event: React.MouseEvent) => void;
}

const TransitionContext = React.createContext<TransitionContextValue | null>(null);

export function useTransitionNavigate(): TransitionContextValue['navigate'] {
  const ctx = React.useContext(TransitionContext);
  if (!ctx) throw new Error('useTransitionNavigate must be used within TransitionProvider');
  return ctx.navigate;
}

const REVEAL_FALLBACK_MS = 4000;

/**
 * The "expand and reveal" transition: a titanium-gold circle grows from the
 * click point via clip-path until it covers the screen, the route changes
 * underneath it, then the same circle shrinks back down to reveal the new
 * page. Mounted once in the root layout — see useTransitionNavigate for how
 * a click wires into it.
 */
export function TransitionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [origin, setOrigin] = React.useState({ x: 0, y: 0 });
  const [phase, setPhase] = React.useState<'idle' | 'covering' | 'covered' | 'revealing'>('idle');
  const pendingPath = React.useRef<string | null>(null);

  const navigate = React.useCallback((href: string, event: React.MouseEvent) => {
    setOrigin({ x: event.clientX, y: event.clientY });
    pendingPath.current = href.split(/[?#]/)[0];
    setPhase('covering');
  }, []);

  // The RSC fetch behind router.push can take longer than one animation
  // frame on a slow connection — wait for the pathname to actually change
  // before shrinking the cover back down, so the old page never peeks
  // through. REVEAL_FALLBACK_MS is an escape hatch so a failed navigation
  // doesn't leave the screen covered forever.
  React.useEffect(() => {
    if (phase !== 'covered' || !pendingPath.current) return;
    if (pathname === pendingPath.current) {
      pendingPath.current = null;
      setPhase('revealing');
      return;
    }
    const timeout = setTimeout(() => {
      pendingPath.current = null;
      setPhase('revealing');
    }, REVEAL_FALLBACK_MS);
    return () => clearTimeout(timeout);
  }, [pathname, phase]);

  function handleAnimationComplete() {
    if (phase === 'covering') {
      setPhase('covered');
      if (pendingPath.current) {
        router.push(pendingPath.current);
      }
    } else if (phase === 'revealing') {
      setPhase('idle');
    }
  }

  return (
    <TransitionContext.Provider value={{ navigate }}>
      {children}
      {phase !== 'idle' ? (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[100] bg-[var(--color-accent)]"
          initial={{ clipPath: `circle(0% at ${origin.x}px ${origin.y}px)` }}
          animate={{
            clipPath:
              phase === 'revealing'
                ? `circle(0% at ${origin.x}px ${origin.y}px)`
                : `circle(150% at ${origin.x}px ${origin.y}px)`,
          }}
          transition={{ duration: 0.7, ease: [0.76, 0, 0.24, 1] }}
          onAnimationComplete={handleAnimationComplete}
        />
      ) : null}
    </TransitionContext.Provider>
  );
}
