'use client';

import * as React from 'react';

/**
 * A radial glow that follows the cursor, mounted once per page (fixed,
 * pointer-events: none, z-index 0 — see `.atlas-spotlight` in tokens.css).
 * Reads the pointer position directly into CSS vars rather than React state
 * so it never triggers a re-render on mousemove.
 */
export function Spotlight() {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleMove(event: MouseEvent) {
      ref.current?.style.setProperty('--spotlight-x', `${event.clientX}px`);
      ref.current?.style.setProperty('--spotlight-y', `${event.clientY}px`);
    }
    window.addEventListener('mousemove', handleMove);
    return () => window.removeEventListener('mousemove', handleMove);
  }, []);

  return <div ref={ref} aria-hidden="true" className="atlas-spotlight" />;
}
