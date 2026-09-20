import type { BadgeProps } from '@atlas/ui';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

/** Every application/message/resume status this app displays, mapped once so a status never gets two different colors in two places. */
const VARIANT_BY_STATUS: Record<string, BadgeVariant> = {
  draft: 'neutral',
  pending: 'neutral',
  processing: 'neutral',
  queued: 'accent',
  submitting: 'accent',
  scheduled: 'accent',
  submitted: 'progress',
  acknowledged: 'progress',
  interviewing: 'progress',
  offer: 'progress',
  sent: 'progress',
  delivered: 'progress',
  replied: 'progress',
  parsed: 'progress',
  withdrawn: 'neutral',
  rejected: 'serious',
  bounced: 'serious',
  failed: 'serious',
};

export function statusVariant(status: string): BadgeVariant {
  return VARIANT_BY_STATUS[status] ?? 'neutral';
}

export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' ');
}
