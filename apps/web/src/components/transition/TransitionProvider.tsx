'use client';

import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
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

/**
 * The "expand and reveal" transition: a titanium-gold circle grows from the
 * click point via clip-path until it covers the screen, the route changes
 * underneath it, then the same circle shrinks back down to reveal the new
 * page. Mounted once in the root layout — see useTransitionNavigate for how
 * a click wires into it.
 */
export function TransitionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [origin, setOrigin] = React.useState({ x: 0, y: 0 });
  const [phase, setPhase] = React.useState<'idle' | 'covering' | 'revealing'>('idle');
  const pendingHref = React.useRef<string | null>(null);

  const navigate = React.useCallback((href: string, event: React.MouseEvent) => {
    setOrigin({ x: event.clientX, y: event.clientY });
    pendingHref.current = href;
    setPhase('covering');
  }, []);

  function handleAnimationComplete() {
    if (phase === 'covering') {
      if (pendingHref.current) {
        router.push(pendingHref.current);
        pendingHref.current = null;
      }
      // Let the new route mount a frame before the reveal starts.
      requestAnimationFrame(() => setPhase('revealing'));
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
              phase === 'covering'
                ? `circle(150% at ${origin.x}px ${origin.y}px)`
                : `circle(0% at ${origin.x}px ${origin.y}px)`,
          }}
          transition={{ duration: 0.7, ease: [0.76, 0, 0.24, 1] }}
          onAnimationComplete={handleAnimationComplete}
        />
      ) : null}
    </TransitionContext.Provider>
  );
}
