import type { BadgeProps } from '@atlas/ui';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

/** Same mapping as apps/web's lib/status-badge.ts, so a status never reads as two different colors in two apps. */
const VARIANT_BY_STATUS: Record<string, BadgeVariant> = {
  draft: 'neutral',
  queued: 'accent',
  submitting: 'accent',
  submitted: 'progress',
  acknowledged: 'progress',
  interviewing: 'progress',
  offer: 'progress',
  withdrawn: 'neutral',
  rejected: 'serious',
  failed: 'serious',
};

export function statusVariant(status: string): BadgeVariant {
  return VARIANT_BY_STATUS[status] ?? 'neutral';
}

export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' ');
}
