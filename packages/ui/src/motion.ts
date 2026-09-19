import type { Transition, Variants } from 'framer-motion';

/**
 * The one place motion timing is decided, so a hero animation and a button
 * hover use the same vocabulary instead of every component inventing its
 * own easing curve.
 */
export const EASE = {
  /** The default for anything entering or leaving the screen. */
  standard: [0.16, 1, 0.3, 1] as const,
  /** Snappier — for hovers and presses, things the user's cursor is driving. */
  responsive: [0.34, 1.56, 0.64, 1] as const,
};

export const DURATION = {
  fast: 0.15,
  base: 0.35,
  slow: 0.6,
  reveal: 0.8,
};

export const springs = {
  /** A little overshoot — used for anything that should feel physically pressed. */
  press: { type: 'spring', stiffness: 500, damping: 30 } satisfies Transition,
  snappy: { type: 'spring', stiffness: 300, damping: 24 } satisfies Transition,
};

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: DURATION.reveal, ease: EASE.standard },
  },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: DURATION.base, ease: EASE.standard } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.94 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: DURATION.base, ease: EASE.standard },
  },
};

/** Wrap a list with this and give each child `fadeUp` for a staggered reveal. */
export const staggerContainer: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08, delayChildren: 0.04 },
  },
};

export const viewportOnce = { once: true, margin: '-80px' };
