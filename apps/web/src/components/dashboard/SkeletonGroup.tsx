import type { ReactNode } from 'react';

/**
 * Wraps placeholder skeletons so assistive tech hears "loading" once, instead
 * of encountering a run of unlabelled empty boxes.
 */
export function SkeletonGroup({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
