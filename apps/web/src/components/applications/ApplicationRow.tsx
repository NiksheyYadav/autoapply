'use client';

import { statusLabel, statusVariant } from '@/lib/status-badge';
import { Badge, Card, fadeUp } from '@atlas/ui';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { toApplicationDisplay, type ApplicationItem } from './view-model';

const LINK_CLASSES =
  'rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]';

/**
 * One row of the applications list. The job summary can be `null` (the job or
 * its company was removed) or absent, so the title, company and link all have
 * a fallback; the row never throws on a missing `job`.
 */
export function ApplicationRow({ application }: { application: ApplicationItem }) {
  const display = toApplicationDisplay(application);
  const employerLine = [display.company, display.location].filter((part): part is string => Boolean(part)).join(' · ');
  const isDraft = application.status === 'draft';

  return (
    <motion.li variants={fadeUp}>
      <Card className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-[var(--color-ink)]">
            {display.jobHref ? (
              <Link href={display.jobHref} className={LINK_CLASSES}>
                {display.title}
              </Link>
            ) : (
              display.title
            )}
          </p>
          {employerLine ? <p className="mt-0.5 break-words text-sm text-[var(--color-ink-soft)]">{employerLine}</p> : null}
          <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
            Started {display.createdLabel}
            {display.submittedLabel ? ` · Submitted ${display.submittedLabel}` : ''}
            {display.jobUnavailable && display.jobHref ? ' · Posting closed' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {isDraft && display.jobHref ? (
            <Link href={display.jobHref} className={`text-sm text-[var(--color-accent)] ${LINK_CLASSES}`}>
              Continue
              <span className="sr-only"> application for {display.title}</span>
            </Link>
          ) : null}
          <Badge variant={statusVariant(application.status)}>{statusLabel(application.status)}</Badge>
        </div>
      </Card>
    </motion.li>
  );
}
