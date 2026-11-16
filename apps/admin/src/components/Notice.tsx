import type { ReactNode } from 'react';

type Tone = 'info' | 'warning' | 'success';

const TONE_CLASSES: Record<Tone, string> = {
  info: 'border-[var(--color-line-strong)] bg-[var(--color-canvas-raised)]',
  warning: 'border-[var(--color-warning)] bg-[var(--color-warning-soft)]',
  success: 'border-[var(--color-progress)] bg-[var(--color-progress-soft)]',
};

/** A short callout. `role="status"` makes a late-appearing notice (a result) announce itself to screen readers. */
export function Notice({
  tone = 'info',
  title,
  children,
  live = false,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  /** Announce when it appears (use for results, not for static page text). */
  live?: boolean;
}) {
  return (
    <div
      role={live ? 'status' : undefined}
      className={`rounded-[var(--radius-control)] border px-4 py-3 text-sm ${TONE_CLASSES[tone]}`}
    >
      {title ? <p className="font-medium text-[var(--color-ink)]">{title}</p> : null}
      <div className={`text-[var(--color-ink-soft)] ${title ? 'mt-1' : ''}`}>{children}</div>
    </div>
  );
}
