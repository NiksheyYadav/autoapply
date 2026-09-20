import * as React from 'react';
import { cn } from '../lib/cn';

export interface LogoProps {
  className?: string;
  size?: number;
  /** Show the "Atlas" wordmark beside the mark. Default true. */
  withWordmark?: boolean;
}

/**
 * The shared mark: an outlined peak with a waypoint node inside — the same
 * map/route idea as RoutePath, distilled into a single glyph. Wrap it in
 * something with the `group` class (or rely on this component's own) to get
 * the hover spin.
 */
export function Logo({ className, size = 32, withWordmark = true }: LogoProps) {
  return (
    <span className={cn('group inline-flex items-center gap-2.5', className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        className="shrink-0 transition-transform duration-500 group-hover:rotate-180"
      >
        <path d="M16 2L30 26H2L16 2Z" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" />
        <path d="M16 12L24 26H8L16 12Z" fill="var(--color-accent)" fillOpacity="0.2" />
        <circle cx="16" cy="18" r="2" fill="var(--color-ink)" />
      </svg>
      {withWordmark ? (
        <span className="font-[var(--font-display)] text-lg font-medium tracking-tight text-[var(--color-ink)]">Atlas</span>
      ) : null}
    </span>
  );
}
