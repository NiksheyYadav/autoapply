'use client';

import { ErrorPanel } from '@/components/ErrorPanel';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { requireAccessToken } from '@/lib/api';
import { useSession } from '@/lib/auth-context';
import { saveText } from '@/lib/download';
import { describeApiError, type Failure } from '@/lib/errors';
import { formatBytes, formatInt } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/idempotency';
import {
  COLUMN_REFERENCE,
  IMPORT_TEMPLATE_FILENAME,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  NOT_UTF8_MESSAGE,
  buildImportTemplate,
  checkImportFile,
  describeRowError,
  groupRowErrors,
  preflightCsv,
  summarizeImport,
} from '@/lib/import-csv';
import { importStudents, type ImportOutcome } from '@/lib/services/admin';
import { Button, Card, CardDescription, CardTitle, Label } from '@atlas/ui';
import { Download, FileUp } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import * as React from 'react';

/** Errors listed row by row before "show all": 5,000 rows of errors would be unusable as a wall of text. */
const ERROR_ROWS_SHOWN = 100;

type Selection =
  | { state: 'none' }
  | { state: 'reading'; name: string }
  | { state: 'rejected'; name: string; message: string }
  | {
      state: 'ready';
      file: File;
      rowCount: number;
      columns: string[];
      /** One key per chosen file; reused for retries so a dropped connection cannot import twice. */
      idempotencyKey: string;
    };

type Submission =
  | { state: 'idle' }
  | { state: 'working' }
  | { state: 'done'; outcome: ImportOutcome }
  | { state: 'error'; failure: Failure };

function ImportResult({ outcome, orgId, onReset }: { outcome: ImportOutcome; orgId: string; onReset: () => void }) {
  const [showAllErrors, setShowAllErrors] = React.useState(false);
  const summary = summarizeImport(outcome.result, outcome.replayed);
  const { errors } = outcome.result;
  const groups = groupRowErrors(errors);
  const visibleErrors = showAllErrors ? errors : errors.slice(0, ERROR_ROWS_SHOWN);

  return (
    <div className="flex flex-col gap-4">
      <Notice
        live
        tone={summary.outcome === 'imported' ? 'success' : summary.outcome === 'nothing_imported' ? 'warning' : 'info'}
        title={summary.headline}
      >
        {summary.notes.length > 0 ? (
          <ul className="list-disc pl-5">
            {summary.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : (
          'Here is where every row in the file ended up.'
        )}
      </Notice>

      <Card>
        <CardTitle>What happened to the rows</CardTitle>
        <div className="relative mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Import result by outcome</caption>
            <thead>
              <tr className="border-b border-[var(--color-line)] text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                <th scope="col" className="py-2 pr-4 font-medium">Outcome</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">Rows</th>
                <th scope="col" className="py-2 font-medium">What it means</th>
              </tr>
            </thead>
            <tbody>
              {summary.lines
                .filter((line) => line.key === 'total' || line.key === 'created' || line.key === 'updated' || line.count > 0)
                .map((line) => (
                  <tr key={line.key} className="border-b border-[var(--color-line)] align-top last:border-0">
                    <th scope="row" className="py-2.5 pr-4 text-left font-normal text-[var(--color-ink)]">{line.label}</th>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-[var(--color-ink)]">{formatInt(line.count)}</td>
                    <td className="py-2.5 text-[var(--color-ink-soft)]">{line.explanation}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      {errors.length > 0 ? (
        <Card>
          <CardTitle>Rows to fix ({formatInt(errors.length)})</CardTitle>
          <CardDescription className="mt-1 mb-3">
            These rows were not imported. Row numbers count the data rows below the header, so they match your
            spreadsheet row minus one, provided there are no blank rows above them (blank rows are skipped, not counted).
            Fix them in the file and import it again: rows already on the roster are left as they are.
          </CardDescription>
          <ul className="mb-4 flex flex-col gap-1 text-sm text-[var(--color-ink-soft)]">
            {groups.map((group) => (
              <li key={group.reason}>
                <span className="tabular-nums text-[var(--color-ink)]">{formatInt(group.count)}</span> × {group.description}
              </li>
            ))}
          </ul>
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Rows with errors</caption>
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                  <th scope="col" className="py-2 pr-4 font-medium">Data row</th>
                  <th scope="col" className="py-2 font-medium">Problem</th>
                </tr>
              </thead>
              <tbody>
                {visibleErrors.map((error) => (
                  <tr key={`${error.row}-${error.reason}`} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="py-2 pr-4 tabular-nums text-[var(--color-ink)]">{formatInt(error.row)}</td>
                    <td className="py-2 text-[var(--color-ink-soft)]">{describeRowError(error.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {errors.length > ERROR_ROWS_SHOWN ? (
            <Button className="mt-3" size="sm" variant="secondary" onClick={() => setShowAllErrors((shown) => !shown)}>
              {showAllErrors ? `Show the first ${ERROR_ROWS_SHOWN}` : `Show all ${formatInt(errors.length)}`}
            </Button>
          ) : null}
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href={`/dashboard/${orgId}/roster`}>View the roster</Link>
        </Button>
        <Button variant="secondary" onClick={onReset}>
          Import another file
        </Button>
      </div>
    </div>
  );
}

export default function ImportPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const pathname = usePathname();
  const { getAccessToken } = useSession();

  const [selection, setSelection] = React.useState<Selection>({ state: 'none' });
  const [submission, setSubmission] = React.useState<Submission>({ state: 'idle' });
  // Remounting the file input is the only way to let someone pick the same file twice in a row.
  const [inputKey, setInputKey] = React.useState(0);
  const latestPick = React.useRef(0);

  function reset() {
    latestPick.current += 1;
    setSelection({ state: 'none' });
    setSubmission({ state: 'idle' });
    setInputKey((key) => key + 1);
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const pick = ++latestPick.current;
    setSubmission({ state: 'idle' });
    if (!file) {
      setSelection({ state: 'none' });
      return;
    }

    const check = checkImportFile(file);
    if (!check.ok) {
      setSelection({ state: 'rejected', name: file.name, message: check.message });
      return;
    }

    setSelection({ state: 'reading', name: file.name });
    let text: string;
    try {
      // Strict decoding: a lenient decoder would silently swap invalid bytes for U+FFFD and corrupt names.
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      if (pick === latestPick.current) setSelection({ state: 'rejected', name: file.name, message: NOT_UTF8_MESSAGE });
      return;
    }
    if (pick !== latestPick.current) return;

    // Only counts and column names are kept; the file's rows are never shown or held after this check.
    const result = preflightCsv(text);
    if (!result.ok) {
      setSelection({ state: 'rejected', name: file.name, message: result.issue.message });
      return;
    }
    setSelection({
      state: 'ready',
      file,
      rowCount: result.rowCount,
      columns: result.columns,
      idempotencyKey: newIdempotencyKey(),
    });
  }

  async function handleImport() {
    if (selection.state !== 'ready') return;
    setSubmission({ state: 'working' });
    try {
      const token = await requireAccessToken(getAccessToken);
      const outcome = await importStudents(token, orgId, selection.file, selection.idempotencyKey);
      setSubmission({ state: 'done', outcome });
    } catch (cause) {
      setSubmission({ state: 'error', failure: describeApiError(cause, 'import') });
    }
  }

  const working = submission.state === 'working';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Import students"
        description="Add students to the roster from a CSV file. You can import the same file again at any time; students who are already up to date are left alone."
      />

      <Notice tone="warning" title="Only students who already have an Atlas account can be added">
        A row is matched to an Atlas account by email. If nobody has signed up with that email, the row is skipped and the
        student is <strong>not</strong> added. Importing never emails or invites anyone. Import the file again after they
        have signed up.
      </Notice>

      {submission.state === 'done' ? (
        <ImportResult outcome={submission.outcome} orgId={orgId} onReset={reset} />
      ) : (
        <>
          <Card>
            <CardTitle>1. Get the template</CardTitle>
            <CardDescription className="mt-1">
              A CSV with the exact columns Atlas accepts and one sample row. Delete the sample row before uploading.
            </CardDescription>
            <Button
              className="mt-4"
              variant="secondary"
              size="sm"
              onClick={() => saveText(buildImportTemplate(), IMPORT_TEMPLATE_FILENAME)}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download template
            </Button>

            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]">
                What goes in each column
              </summary>
              <div className="relative mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Import columns</caption>
                  <thead>
                    <tr className="border-b border-[var(--color-line)] text-left text-xs uppercase tracking-wide text-[var(--color-ink-faint)]">
                      <th scope="col" className="py-2 pr-4 font-medium">Column</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Required</th>
                      <th scope="col" className="py-2 font-medium">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COLUMN_REFERENCE.map((column) => (
                      <tr key={column.column} className="border-b border-[var(--color-line)] align-top last:border-0">
                        <th scope="row" className="py-2 pr-4 text-left font-mono text-xs font-normal text-[var(--color-ink)]">
                          {column.column}
                        </th>
                        <td className="py-2 pr-4 text-[var(--color-ink-soft)]">{column.required ? 'Yes' : 'No'}</td>
                        <td className="py-2 text-[var(--color-ink-soft)]">{column.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
                Columns can be in any order. Up to {formatInt(MAX_IMPORT_ROWS)} students and {formatBytes(MAX_IMPORT_BYTES)}{' '}
                per file; save as CSV (UTF-8).
              </p>
            </details>
          </Card>

          <Card>
            <CardTitle>2. Choose your file</CardTitle>
            <CardDescription className="mt-1 mb-4">
              The file is checked in your browser first, then sent to Atlas. This console does not keep a copy of it.
            </CardDescription>
            <Label htmlFor="import-file">CSV file</Label>
            <input
              key={inputKey}
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              disabled={working}
              onChange={(event) => void handleFile(event)}
              aria-describedby="import-file-status"
              className="block w-full text-sm text-[var(--color-ink-soft)] file:mr-4 file:cursor-pointer file:rounded-full file:border-0 file:bg-white/10 file:px-4 file:py-2.5 file:text-sm file:font-medium file:text-[var(--color-ink)] hover:file:bg-white/15 disabled:opacity-50"
            />

            <div id="import-file-status" className="mt-4" aria-live="polite">
              {selection.state === 'reading' ? (
                <p className="text-sm text-[var(--color-ink-soft)]">Checking {selection.name}…</p>
              ) : null}
              {selection.state === 'rejected' ? (
                <div role="alert" className="rounded-[var(--radius-control)] border border-[var(--color-serious)] bg-[var(--color-serious-soft)] px-4 py-3 text-sm">
                  <p className="font-medium text-[var(--color-ink)]">This file can’t be imported</p>
                  <p className="mt-1 text-[var(--color-ink-soft)]">{selection.message}</p>
                </div>
              ) : null}
              {selection.state === 'ready' ? (
                <div className="rounded-[var(--radius-control)] border border-[var(--color-progress)] bg-[var(--color-progress-soft)] px-4 py-3 text-sm">
                  <p className="font-medium text-[var(--color-ink)]">Ready to import</p>
                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-[var(--color-ink-soft)] sm:grid-cols-[auto_1fr]">
                    <dt>File</dt>
                    <dd className="min-w-0 truncate text-[var(--color-ink)]">
                      {selection.file.name} ({formatBytes(selection.file.size)})
                    </dd>
                    <dt>Students</dt>
                    <dd className="text-[var(--color-ink)]">{formatInt(selection.rowCount)}</dd>
                    <dt>Columns</dt>
                    <dd className="font-mono text-xs text-[var(--color-ink)]">{selection.columns.join(', ')}</dd>
                  </dl>
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardTitle>3. Import</CardTitle>
            <CardDescription className="mt-1">
              Rows with problems don’t stop the others: Atlas imports what it can and tells you which rows to fix.
            </CardDescription>
            {submission.state === 'error' ? (
              <div className="mt-4">
                <ErrorPanel
                  failure={submission.failure}
                  onRetry={selection.state === 'ready' ? () => void handleImport() : undefined}
                  signInNext={pathname}
                />
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={() => void handleImport()} disabled={selection.state !== 'ready' || working}>
                <FileUp className="h-4 w-4" aria-hidden="true" />
                {working ? 'Importing…' : selection.state === 'ready' ? `Import ${formatInt(selection.rowCount)} students` : 'Import'}
              </Button>
              {selection.state !== 'none' && !working ? (
                <Button variant="ghost" onClick={reset}>
                  Choose a different file
                </Button>
              ) : null}
              {working ? (
                <p role="status" className="text-sm text-[var(--color-ink-soft)]">
                  Importing. A large file can take a little while; please keep this page open.
                </p>
              ) : null}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
