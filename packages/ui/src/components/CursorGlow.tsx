'use client';

import { motion, useMotionValue, useSpring } from 'framer-motion';
import * as React from 'react';

/**
 * A small titanium dot that trails the cursor with a spring lag — distinct
 * from Spotlight's big ambient wash, this is a precise "the cursor itself
 * feels alive" touch. Hides on touch devices (no pointer to trail) and
 * respects reduced-motion.
 */
export function CursorGlow() {
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const springX = useSpring(x, { stiffness: 700, damping: 40, mass: 0.4 });
  const springY = useSpring(y, { stiffness: 700, damping: 40, mass: 0.4 });
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (window.matchMedia('(pointer: coarse)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    function handleMove(event: MouseEvent) {
      x.set(event.clientX);
      y.set(event.clientY);
      setVisible(true);
    }
    function handleLeave() {
      setVisible(false);
    }
    window.addEventListener('mousemove', handleMove);
    document.documentElement.addEventListener('mouseleave', handleLeave);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      document.documentElement.removeEventListener('mouseleave', handleLeave);
    };
  }, [x, y]);

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 z-[60] h-2 w-2 rounded-full bg-[var(--color-accent)]"
      style={{
        x: springX,
        y: springY,
        translateX: '-50%',
        translateY: '-50%',
        boxShadow: '0 0 12px 2px var(--color-accent)',
      }}
      animate={{ opacity: visible ? 0.9 : 0 }}
      transition={{ duration: 0.2 }}
    />
  );
}
