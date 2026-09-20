import * as React from 'react';
import { cn } from '../lib/cn';

export interface MarqueeProps {
  className?: string;
  /** Seconds for one full loop of the track — lower is faster. */
  durationSeconds?: number;
  reverse?: boolean;
  children: React.ReactNode;
}

/**
 * An infinite horizontal scroller: renders `children` twice back-to-back and
 * loops the pair with a pure-CSS animation (see tokens.css), so a wide row
 * of logos/cards never costs a per-frame JS animation.
 */
export function Marquee({ className, durationSeconds = 28, reverse = false, children }: MarqueeProps) {
  return (
    <div
      className={cn('atlas-marquee', className)}
      style={{ '--atlas-marquee-duration': `${durationSeconds}s` } as React.CSSProperties}
    >
      <div className={cn('atlas-marquee__track', reverse && 'atlas-marquee__track--reverse')}>
        <div className="atlas-marquee__group">{children}</div>
        <div className="atlas-marquee__group" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
}
