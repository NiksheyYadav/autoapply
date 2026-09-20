import type { CSSProperties } from 'react';

/**
 * Three large, heavily blurred orbs drifting independently behind the page
 * — titanium gold, a cool indigo, and a cyan, each on its own float cycle
 * (`.atlas-orb` in tokens.css) so they never move in lockstep. Purely
 * decorative: `aria-hidden`, fixed behind everything, never intercepts clicks.
 */
export function FloatingOrbs() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="atlas-orb absolute top-[8%] left-[12%] h-[480px] w-[480px] rounded-full bg-[var(--color-accent)]/[0.08] blur-[120px]"
        style={{ '--atlas-orb-duration': '19s', '--atlas-orb-delay': '0s' } as CSSProperties}
      />
      <div
        className="atlas-orb absolute top-[45%] right-[8%] h-[560px] w-[560px] rounded-full bg-indigo-500/[0.10] blur-[140px]"
        style={{ '--atlas-orb-duration': '23s', '--atlas-orb-delay': '-6s' } as CSSProperties}
      />
      <div
        className="atlas-orb absolute bottom-[6%] left-[35%] h-[420px] w-[420px] rounded-full bg-cyan-400/[0.06] blur-[110px]"
        style={{ '--atlas-orb-duration': '21s', '--atlas-orb-delay': '-11s' } as CSSProperties}
      />
    </div>
  );
}
