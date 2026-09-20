'use client';

/**
 * Decorative UI chrome, not a live feed — it illustrates what the pipeline
 * looks like while running rather than reporting a real visitor's data (an
 * anonymous landing-page visitor has no pipeline running). Same spirit as
 * RoutePath: an illustrative diagram of the product, not a telemetry claim.
 */
export function PipelineDock() {
  return (
    <div className="pointer-events-none fixed bottom-8 left-1/2 z-50 hidden -translate-x-1/2 md:block">
      <div className="atlas-glass pointer-events-auto flex items-center gap-6 rounded-full px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-accent)] opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--color-accent)]" />
          </span>
          <span className="font-[var(--font-mono)] text-xs font-semibold tracking-wider text-[var(--color-ink)]">
            PIPELINE ACTIVE
          </span>
        </div>
        <div className="h-5 w-px bg-[var(--color-line)]" />
        <div className="flex items-center gap-4 font-[var(--font-mono)] text-xs text-[var(--color-ink-faint)]">
          <span>4 agents</span>
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-2/3 animate-pulse rounded-full bg-[var(--color-accent)]" />
          </div>
          <span>
            Match: <strong className="text-[var(--color-ink)]">94%</strong>
          </span>
        </div>
      </div>
    </div>
  );
}
