'use client';

import { motion, useMotionValue, useSpring } from 'framer-motion';
import * as React from 'react';
import { cn } from '../lib/cn';

export interface MagneticHoverProps extends React.HTMLAttributes<HTMLDivElement> {
  /** How far the element is pulled toward the cursor, in pixels. */
  strength?: number;
  children: React.ReactNode;
}

/**
 * Atlas's invented hover signature: the element leans toward the cursor as
 * it approaches, like a compass needle finding north, then springs back on
 * exit. Wrap a Button or Card in this rather than reaching for a generic
 * scale-on-hover.
 */
export const MagneticHover = React.forwardRef<HTMLDivElement, MagneticHoverProps>(
  ({ strength = 14, className, children, ...props }, forwardedRef) => {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useImperativeHandle(forwardedRef, () => ref.current as HTMLDivElement);

    const x = useMotionValue(0);
    const y = useMotionValue(0);
    const springX = useSpring(x, { stiffness: 250, damping: 18, mass: 0.4 });
    const springY = useSpring(y, { stiffness: 250, damping: 18, mass: 0.4 });

    function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
      const bounds = ref.current?.getBoundingClientRect();
      if (!bounds) return;
      const relX = (event.clientX - bounds.left) / bounds.width - 0.5;
      const relY = (event.clientY - bounds.top) / bounds.height - 0.5;
      x.set(relX * strength);
      y.set(relY * strength);
    }

    function handleMouseLeave() {
      x.set(0);
      y.set(0);
    }

    return (
      <motion.div
        ref={ref}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ x: springX, y: springY }}
        className={cn('inline-block', className)}
        {...(props as React.ComponentProps<typeof motion.div>)}
      >
        {children}
      </motion.div>
    );
  },
);
MagneticHover.displayName = 'MagneticHover';
