'use client';

import { ErrorPanel } from '@/components/ErrorPanel';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { requireAccessToken } from '@/lib/api';
import { useSession } from '@/lib/auth-context';
import { formatDateTime, formatInt } from '@/lib/format';
import { barPercent, buildFunnelStages, statusRows, toFunnelQuery, type FunnelQuery } from '@/lib/funnel';
import { getFunnel } from '@/lib/services/admin';
import { statusLabel, statusVariant } from '@/lib/status-badge';
import { useResource } from '@/lib/use-resource';
import { Badge, Button, Card, CardDescription, CardTitle, Input, Label, Skeleton } from '@atlas/ui';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import * as React from 'react';

function windowLabel(range: { from: string | null; to: string | null }): string {
  if (!range.from && !range.to) return 'All time';
  const day = (iso: string) => iso.slice(0, 10);
  if (range.from && range.to) return `${day(range.from)} to ${day(range.to)} (UTC, end day not included)`;
  if (range.from) return `From ${day(range.from)} (UTC)`;
  return `Before ${day(range.to ?? '')} (UTC)`;
}

export default function FunnelPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const pathname = usePathname();
  const { getAccessToken } = useSession();

  const [draft, setDraft] = React.useState({ from: '', to: '' });
  const [applied, setApplied] = React.useState<FunnelQuery>({});
  const [rangeError, setRangeError] = React.useState<string | null>(null);

  const appliedKey = JSON.stringify(applied);
  const funnel = useResource(
    async (signal) => getFunnel(await requireAccessToken(getAccessToken), orgId, applied, signal),
    [orgId, appliedKey, getAccessToken],
    'funnel',
  );

  function applyRange(event: React.FormEvent) {
    event.preventDefault();
    const result = toFunnelQuery(draft);
    if (!result.ok) {
      setRangeError(result.message);
      return;
    }
    setRangeError(null);
    setApplied(result.query);
  }

  function clearRange() {
    setDraft({ from: '', to: '' });
    setRangeError(null);
    setApplied({});
  }

  const data = funnel.data;
  const stages = data ? buildFunnelStages(data) : [];
  const rosterSize = data?.roster.size ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Student funnel"
        description="How far along the students on your roster are: signed up, resume uploaded, applied, offer. Figures are counts, as the API reports them."
        actions={
          <Button variant="secondary" size="sm" onClick={funnel.reload} disabled={funnel.loading}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <Card>
        <form onSubmit={applyRange} className="flex flex-col gap-4 sm:flex-row sm:items-end" noValidate>
          <div>
            <Label htmlFor="range-from">Activity from (UTC)</Label>
            <Input
              id="range-from"
              type="date"
              value={draft.from}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="range-to">Activity to, inclusive (UTC)</Label>
            <Input
              id="range-to"
              type="date"
              value={draft.to}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" disabled={funnel.loading}>
              Apply dates
            </Button>
            <Button type="button" variant="ghost" onClick={clearRange} disabled={draft.from === '' && draft.to === '' && appliedKey === '{}'}>
              Clear
            </Button>
          </div>
        </form>
        {rangeError ? (
          <p role="alert" className="mt-3 text-sm text-[var(--color-serious)]">
            {rangeError}
          </p>
        ) : null}
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
          Dates only narrow <em>activity</em>: resumes uploaded and applications made in that window. The roster counts
          are always as of now.
        </p>
      </Card>

      {funnel.error ? (
        <ErrorPanel failure={funnel.error} onRetry={funnel.reload} signInNext={pathname} />
      ) : funnel.loading && !data ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading funnel">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : data ? (
        <div className={`flex flex-col gap-6 ${funnel.loading ? 'opacity-60' : ''}`} aria-busy={funnel.loading}>
          {rosterSize === 0 ? (
            <Card>
              <CardTitle>The roster is empty</CardTitle>
              <CardDescription className="mt-2">
                There are no students to count yet. Import a roster to get started.
              </CardDescription>
              <Button asChild className="mt-4" size="sm">
                <Link href={`/dashboard/${orgId}/import`}>Import students</Link>
              </Button>
            </Card>
          ) : (
            <>
              {data.roster.sharing_enabled === 0 ? (
                <Notice tone="info" title="No resume or application figures yet">
                  None of the {formatInt(rosterSize)} students on the roster are members of this organization on Atlas
                  yet. Resume and application figures cover only students who are, so they all read 0 for now. That is
                  &ldquo;not shared&rdquo;, not &ldquo;no activity&rdquo;.
                </Notice>
              ) : null}

              <Card>
                <CardTitle>Students at each stage</CardTitle>
                <CardDescription className="mt-1 mb-4">
                  Bars compare each count to the {formatInt(rosterSize)} students on the roster. Activity window:{' '}
                  {windowLabel(data.range)}.
                </CardDescription>
                {/* `relative` so the table's absolutely positioned sr-only text is clipped with it, not left to widen the page. */}
                <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Students at each stage">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Number of students at each stage of the funnel</caption>
                    <thead>
                      <tr className="border-b border-[var(--color-line)] text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                        <th scope="col" className="py-2 pr-4 font-medium">Stage</th>
                        <th scope="col" className="py-2 pr-4 text-right font-medium">Students</th>
                        <th scope="col" className="hidden py-2 pr-4 font-medium sm:table-cell">
                          <span className="sr-only">Share of roster</span>
                        </th>
                        <th scope="col" className="py-2 font-medium">Counted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stages.map((stage) => (
                        <tr key={stage.key} className="border-b border-[var(--color-line)] last:border-0 align-top">
                          <th scope="row" className="py-3 pr-4 text-left font-normal">
                            <span className="text-[var(--color-ink)]">{stage.label}</span>
                            <span className="mt-0.5 block text-xs text-[var(--color-ink-faint)]">{stage.description}</span>
                          </th>
                          <td className="py-3 pr-4 text-right tabular-nums text-[var(--color-ink)]">{formatInt(stage.count)}</td>
                          <td className="hidden w-1/3 py-3 pr-4 sm:table-cell" aria-hidden="true">
                            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-canvas-raised)]">
                              <div
                                className="h-full rounded-full bg-[var(--color-accent)]"
                                style={{ width: `${barPercent(stage.count, rosterSize)}%` }}
                              />
                            </div>
                          </td>
                          <td className="py-3 text-xs text-[var(--color-ink-faint)]">
                            {stage.basis === 'now' ? 'As of now' : 'In activity window'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div className="grid gap-6 md:grid-cols-2">
                <Card>
                  <CardTitle>Applications</CardTitle>
                  <CardDescription className="mt-1 mb-4">
                    Made in this organization&apos;s context by students who are members of it.
                  </CardDescription>
                  <dl className="mb-4 grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <dt className="text-[var(--color-ink-faint)]">Applications</dt>
                      <dd className="text-xl tabular-nums text-[var(--color-ink)]">{formatInt(data.applications.total)}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-ink-faint)]">Students who applied</dt>
                      <dd className="text-xl tabular-nums text-[var(--color-ink)]">{formatInt(data.applications.students_applied)}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-ink-faint)]">Offers</dt>
                      <dd className="text-xl tabular-nums text-[var(--color-ink)]">
                        {formatInt(data.offers.applications)}{' '}
                        <span className="text-sm text-[var(--color-ink-faint)]">
                          from {formatInt(data.offers.students)} {data.offers.students === 1 ? 'student' : 'students'}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-ink-faint)]">Average ATS score</dt>
                      <dd className="text-xl tabular-nums text-[var(--color-ink)]">
                        {data.resumes.avg_ats_score === null ? (
                          <span className="text-sm text-[var(--color-ink-faint)]">No scored resumes</span>
                        ) : (
                          data.resumes.avg_ats_score.toFixed(1)
                        )}
                      </dd>
                    </div>
                  </dl>
                </Card>

                <Card>
                  <CardTitle>Applications by status</CardTitle>
                  <CardDescription className="mt-1 mb-4">Each application is counted once, at its current status.</CardDescription>
                  <table className="w-full text-sm">
                    <caption className="sr-only">Application counts by status</caption>
                    <thead>
                      <tr className="border-b border-[var(--color-line)] text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                        <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                        <th scope="col" className="py-2 text-right font-medium">Applications</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statusRows(data.applications.by_status).map((row) => (
                        <tr key={row.status} className="border-b border-[var(--color-line)] last:border-0">
                          <th scope="row" className="py-2 pr-4 text-left font-normal">
                            <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>
                          </th>
                          <td className="py-2 text-right tabular-nums text-[var(--color-ink)]">{formatInt(row.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>

              <p className="text-xs text-[var(--color-ink-faint)]">Generated {formatDateTime(data.generated_at)}.</p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
