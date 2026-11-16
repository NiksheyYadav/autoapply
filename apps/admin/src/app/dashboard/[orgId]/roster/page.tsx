'use client';

import { ErrorPanel } from '@/components/ErrorPanel';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Select } from '@/components/Select';
import { requireAccessToken } from '@/lib/api';
import { useSession } from '@/lib/auth-context';
import { ADMIN_MAX_EXPORT_ROWS, APPLICATION_STATUSES } from '@/lib/contracts';
import { saveBlob } from '@/lib/download';
import { describeApiError, type Failure } from '@/lib/errors';
import { formatDate, formatInt } from '@/lib/format';
import { advance, canGoBack, currentCursor, goBack, initialPageState, pageNumber } from '@/lib/pagination';
import {
  DEFAULT_PAGE_SIZE,
  EMPTY_ROSTER_FILTER,
  MAX_SEARCH_LENGTH,
  PAGE_SIZES,
  hasActiveFilters,
  isApplicationStatus,
  isPageSize,
  normalizeSearch,
  type HasResumeFilter,
  type PageSize,
  type RosterFilterState,
} from '@/lib/roster-query';
import { exportStudents, listStudents } from '@/lib/services/admin';
import { statusLabel } from '@/lib/status-badge';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useResource } from '@/lib/use-resource';
import type { RosterStudent } from '@atlas/types';
import { Badge, Button, Card, Input, Label, Skeleton } from '@atlas/ui';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import * as React from 'react';

const NOT_SHARED = (
  <>
    <span aria-hidden="true">—</span>
    <span className="sr-only">Not shared</span>
  </>
);

function StudentRow({ student }: { student: RosterStudent }) {
  const insights = student.insights;
  return (
    <tr className="border-b border-[var(--color-line)] last:border-0">
      <th scope="row" className="max-w-[18rem] truncate py-2.5 pr-4 text-left font-normal text-[var(--color-ink)]">
        {student.email}
      </th>
      <td className="py-2.5 pr-4 text-[var(--color-ink-soft)]">{student.full_name ?? NOT_SHARED}</td>
      <td className="py-2.5 pr-4 text-[var(--color-ink-soft)]">{student.program ?? <span aria-hidden="true">—</span>}</td>
      <td className="py-2.5 pr-4 tabular-nums text-[var(--color-ink-soft)]">
        {student.graduation_year ?? <span aria-hidden="true">—</span>}
      </td>
      <td className="py-2.5 pr-4">
        <Badge variant={student.status === 'active' ? 'progress' : 'neutral'} className="whitespace-nowrap">{statusLabel(student.status)}</Badge>
      </td>
      <td className="py-2.5 pr-4">
        <Badge variant={student.sharing_enabled ? 'accent' : 'neutral'} className="whitespace-nowrap">
          {student.sharing_enabled ? 'Shared' : 'Not shared'}
        </Badge>
      </td>
      <td className="py-2.5 pr-4 text-[var(--color-ink-soft)]">
        {insights ? (insights.has_resume ? 'Yes' : 'No') : NOT_SHARED}
      </td>
      <td className="py-2.5 pr-4 tabular-nums text-[var(--color-ink-soft)]">
        {insights ? (insights.latest_ats_score !== null ? insights.latest_ats_score.toFixed(1) : <span aria-hidden="true">—</span>) : NOT_SHARED}
      </td>
      <td className="py-2.5 pr-4 tabular-nums text-[var(--color-ink-soft)]">
        {insights ? formatInt(insights.applications_total) : NOT_SHARED}
      </td>
      <td className="py-2.5 text-[var(--color-ink-faint)]">
        {insights ? formatDate(insights.last_application_activity_at) : NOT_SHARED}
      </td>
    </tr>
  );
}

type ExportState =
  | { state: 'idle' }
  | { state: 'working' }
  | { state: 'done'; filename: string }
  | { state: 'error'; failure: Failure };

export default function RosterPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const pathname = usePathname();
  const { getAccessToken } = useSession();

  // Filter inputs live in component state only. They are deliberately NOT put
  // in the URL or in browser storage: a search term is often a student's email.
  const [searchInput, setSearchInput] = React.useState('');
  const [hasResume, setHasResume] = React.useState<HasResumeFilter>('any');
  const [applicationStatus, setApplicationStatus] = React.useState<RosterFilterState['applicationStatus']>('');
  const [pageSize, setPageSize] = React.useState<PageSize>(DEFAULT_PAGE_SIZE);
  const [exporting, setExporting] = React.useState<ExportState>({ state: 'idle' });

  const debouncedSearch = useDebouncedValue(searchInput, 350);
  const filter = React.useMemo<RosterFilterState>(
    () => ({ search: normalizeSearch(debouncedSearch), hasResume, applicationStatus }),
    [debouncedSearch, hasResume, applicationStatus],
  );

  // Any change to the filter or page size starts again from page 1. The
  // cursor history is keyed by the filter so a stale cursor is never reused.
  const filterKey = JSON.stringify([orgId, filter, pageSize]);
  const [paging, setPaging] = React.useState(() => ({ key: filterKey, state: initialPageState() }));
  const pageState = paging.key === filterKey ? paging.state : initialPageState();
  const cursor = currentCursor(pageState);

  const roster = useResource(
    async (signal) =>
      listStudents(await requireAccessToken(getAccessToken), orgId, filter, { limit: pageSize, cursor }, signal),
    [filterKey, cursor, getAccessToken],
    'roster',
  );

  const data = roster.data;
  const filtered = hasActiveFilters(filter);
  const typing = normalizeSearch(searchInput) !== filter.search;

  function clearFilters() {
    setSearchInput(EMPTY_ROSTER_FILTER.search);
    setHasResume(EMPTY_ROSTER_FILTER.hasResume);
    setApplicationStatus(EMPTY_ROSTER_FILTER.applicationStatus);
  }

  async function handleExport() {
    setExporting({ state: 'working' });
    try {
      const token = await requireAccessToken(getAccessToken);
      const fallback = `students-${new Date().toISOString().slice(0, 10)}.csv`;
      const file = await exportStudents(token, orgId, filter, fallback);
      saveBlob(file.blob, file.filename);
      setExporting({ state: 'done', filename: file.filename });
    } catch (cause) {
      setExporting({ state: 'error', failure: describeApiError(cause, 'export') });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Student roster"
        description="The students your university has added, with their status. Activity details appear only for students who are also members of this organization."
        actions={
          <>
            <Button asChild variant="secondary" size="sm">
              <Link href={`/dashboard/${orgId}/import`}>Import students</Link>
            </Button>
            <Button size="sm" onClick={() => void handleExport()} disabled={exporting.state === 'working'}>
              <Download className="h-4 w-4" aria-hidden="true" />
              {exporting.state === 'working' ? 'Preparing…' : filtered ? 'Export filtered CSV' : 'Export CSV'}
            </Button>
          </>
        }
      />

      {exporting.state === 'error' ? (
        <ErrorPanel
          failure={exporting.failure}
          onRetry={() => void handleExport()}
          signInNext={pathname}
        />
      ) : exporting.state === 'done' ? (
        <Notice tone="success" live title="Export downloaded">
          Saved as {exporting.filename}. It contains student email addresses, so store and share it with care. This export
          has been recorded in the organization&apos;s audit trail.
        </Notice>
      ) : (
        <p className="text-xs text-[var(--color-ink-faint)]">
          The export covers every student matching the filters below, not just this page (at most{' '}
          {formatInt(ADMIN_MAX_EXPORT_ROWS)}). Each export is recorded in the organization&apos;s audit trail.
        </p>
      )}

      <Card>
        <form
          role="search"
          aria-label="Filter the roster"
          onSubmit={(event) => event.preventDefault()}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <div className="sm:col-span-2">
            <Label htmlFor="roster-search">Search by email or name</Label>
            <Input
              id="roster-search"
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              maxLength={MAX_SEARCH_LENGTH}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="e.g. jane@university.edu"
              aria-describedby="roster-search-help"
            />
            <p id="roster-search-help" className="mt-1 text-xs text-[var(--color-ink-faint)]">
              Names are searchable only for students who are members of this organization.
            </p>
          </div>
          <div>
            <Label htmlFor="roster-resume">Resume</Label>
            <Select
              id="roster-resume"
              value={hasResume}
              onChange={(event) => setHasResume(event.target.value as HasResumeFilter)}
            >
              <option value="any">Any</option>
              <option value="yes">Has a resume</option>
              <option value="no">No resume</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="roster-status">Has an application that is</Label>
            <Select
              id="roster-status"
              value={applicationStatus}
              onChange={(event) => {
                const value = event.target.value;
                setApplicationStatus(isApplicationStatus(value) ? value : '');
              }}
            >
              <option value="">Any status</option>
              {APPLICATION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </Select>
          </div>
        </form>
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
          Resume and application filters match only students who are members of this organization. For everyone else
          those facts are unknown, so they are never counted as &ldquo;no&rdquo;.
        </p>
      </Card>

      {roster.error ? (
        <ErrorPanel failure={roster.error} onRetry={roster.reload} signInNext={pathname} />
      ) : roster.loading && !data ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading roster">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : data ? (
        data.items.length === 0 ? (
          <Card>
            {filtered ? (
              <>
                <p className="text-[var(--color-ink)]">No students match these filters.</p>
                <Button className="mt-4" size="sm" variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              </>
            ) : canGoBack(pageState) ? (
              <>
                <p className="text-[var(--color-ink)]">There are no more students.</p>
                <Button
                  className="mt-4"
                  size="sm"
                  variant="secondary"
                  onClick={() => setPaging({ key: filterKey, state: goBack(pageState) })}
                >
                  Back to the previous page
                </Button>
              </>
            ) : (
              <>
                <p className="text-[var(--color-ink)]">No students on the roster yet.</p>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  Import a CSV to add them. Only students who already have an Atlas account can be added; nobody is
                  emailed or invited by an import.
                </p>
                <Button asChild className="mt-4" size="sm">
                  <Link href={`/dashboard/${orgId}/import`}>Import students</Link>
                </Button>
              </>
            )}
          </Card>
        ) : (
          <div className={`flex flex-col gap-3 ${roster.loading || typing ? 'opacity-60' : ''}`} aria-busy={roster.loading}>
            <div
              className="relative overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2"
              tabIndex={0}
              role="region"
              aria-label="Student roster table"
            >
              <table className="w-full min-w-[56rem] text-sm">
                <caption className="sr-only">
                  Students on the roster, page {pageNumber(pageState)}
                </caption>
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                    <th scope="col" className="py-2 pr-4 font-medium">Email</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Name</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Program</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Grad. year</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Sharing</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Resume</th>
                    <th scope="col" className="py-2 pr-4 font-medium">ATS score</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Applications</th>
                    <th scope="col" className="py-2 font-medium">Last application</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((student) => (
                    <StudentRow key={student.student_id} student={student} />
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-[var(--color-ink-faint)]">
              &ldquo;Shared&rdquo; means the student is also a member of this organization on Atlas. For students who are
              not shared, name and activity are unknown; a dash does not mean zero.
            </p>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="status" aria-live="polite" className="text-sm text-[var(--color-ink-soft)]">
                Page {pageNumber(pageState)} · {formatInt(data.items.length)}{' '}
                {data.items.length === 1 ? 'student' : 'students'}
                {data.next_cursor === null ? ' · end of the roster' : ''}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="roster-page-size" className="mb-0 whitespace-nowrap">
                    Per page
                  </Label>
                  <Select
                    id="roster-page-size"
                    className="w-24"
                    value={String(pageSize)}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (isPageSize(next)) setPageSize(next);
                    }}
                  >
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!canGoBack(pageState) || roster.loading}
                  onClick={() => setPaging({ key: filterKey, state: goBack(pageState) })}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={data.next_cursor === null || roster.loading}
                  onClick={() => setPaging({ key: filterKey, state: advance(pageState, data.next_cursor) })}
                >
                  Next
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
