'use client';

import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardDescription, CardTitle } from '@atlas/ui';

/**
 * There is no way to read the audit trail yet: admin-service writes an audit
 * entry for every roster import and export (repo/audit.ts) but exposes no
 * endpoint that lists them. This page says exactly that and nothing more, and
 * calls no API. When a read endpoint exists, this is where the table goes.
 */
export default function AuditLogPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="A record of who imported or exported the roster, and when."
      />

      <Notice tone="warning" title="Viewing the audit log is not available yet">
        Atlas records an entry each time a roster is imported or exported, but this console has no way to read those
        entries back yet, so it cannot show them.
      </Notice>

      <Card>
        <CardTitle>What is recorded today</CardTitle>
        <CardDescription className="mt-1 mb-3">
          Each entry stores who did it, when, and a few counts. It never stores student emails, names, or search terms.
        </CardDescription>
        <ul className="list-disc pl-5 text-sm text-[var(--color-ink-soft)]">
          <li>
            <span className="text-[var(--color-ink)]">Roster import:</span> the source (CSV or JSON), and how many rows
            were read, created, updated, skipped, and rejected.
          </li>
          <li>
            <span className="text-[var(--color-ink)]">Roster export:</span> the file format, the number of students
            exported, and which filters were used (their names only, not their values).
          </li>
        </ul>
        <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
          Viewing the roster or the funnel is not recorded.
        </p>
      </Card>
    </div>
  );
}
