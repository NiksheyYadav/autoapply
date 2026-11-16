'use client';

import { SkeletonGroup } from '@/components/dashboard/SkeletonGroup';
import { useSession } from '@/lib/auth-context';
import { appendApplicationEvent, createApplication, findApplicationForJobId } from '@/lib/services/applications';
import { statusLabel, statusVariant } from '@/lib/status-badge';
import type { Job, Resume } from '@atlas/types';
import { Badge, Button, Card, CardDescription, CardTitle, Skeleton } from '@atlas/ui';
import { Check, ExternalLink, LoaderCircle, SendHorizontal } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { resumeStateHint, type ResumeState } from '../resume-check/report-view-model';
import { failureInfo, failureMessage } from './failure-message';
import { externalUrlHost } from './external-url';
import { formatServiceDate } from './timestamp';
import {
  buildApplicationIdempotencyKey,
  deriveApplyStage,
  MARKED_SUBMITTED_NOTE,
  mergeApplication,
  OPENED_APPLY_LINK_NOTE,
  resolveApplyUrl,
  type ApplicationItem,
} from './view-model';

type FocusTarget = 'open' | 'status' | 'confirm' | 'submit';

export interface AssistedApplyPanelProps {
  job: Job;
  /** The resume chosen above the panels; the application is created with it. */
  resume: Resume | null;
  availability: ResumeState;
  /** This user's application for the job, if one exists. */
  application: ApplicationItem | null;
  /** Whether we are still looking for an existing application, or failed to. */
  lookup: { loading: boolean; failed: boolean };
  onApplicationChange: (next: ApplicationItem) => void;
  /** Re-reads the application from the server (after a failed lookup or a stale-state error). */
  onRefresh: () => void;
}

function Step({
  number,
  title,
  done,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={
          done
            ? 'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-progress-soft)] text-[var(--color-progress)]'
            : 'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-line-strong)] text-xs text-[var(--color-ink-soft)]'
        }
      >
        {done ? <Check className="h-3.5 w-3.5" /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--color-ink)]">
          {title}
          {done ? <span className="sr-only"> (done)</span> : null}
        </p>
        <div className="mt-1 text-sm text-[var(--color-ink-soft)]">{children}</div>
      </div>
    </li>
  );
}

/**
 * Assisted apply: Atlas tracks the application; the candidate submits it on
 * the employer's own site. Nothing here, in copy or behaviour, submits
 * anything to an employer.
 */
export function AssistedApplyPanel({
  job,
  resume,
  availability,
  application,
  lookup,
  onApplicationChange,
  onRefresh,
}: AssistedApplyPanelProps) {
  const { accessToken } = useSession();
  const stage = deriveApplyStage(application);
  const applyUrl = resolveApplyUrl(application, job.apply_url);
  const applyHost = externalUrlHost(applyUrl);

  const [pending, setPending] = React.useState<'start' | 'submit' | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; stale: boolean } | null>(null);
  const [markerWarning, setMarkerWarning] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [openedThisSession, setOpenedThisSession] = React.useState(false);
  const [focusTarget, setFocusTarget] = React.useState<FocusTarget | null>(null);

  // Synchronous guards: state updates are async, so a fast double click could otherwise send twice.
  const busy = React.useRef(false);
  const recordingOpen = React.useRef(false);
  const openRecorded = React.useRef(false);

  const openLinkRef = React.useRef<HTMLAnchorElement>(null);
  const statusRef = React.useRef<HTMLHeadingElement>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);
  const submitRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!focusTarget) return;
    const target = { open: openLinkRef, status: statusRef, confirm: confirmRef, submit: submitRef }[focusTarget].current;
    target?.focus();
    setFocusTarget(null);
  }, [focusTarget, stage, confirming]);

  const jobClosed = !job.is_active;

  /** Drops this panel's own transient state, then re-reads the application from the server. */
  function refresh() {
    setError(null);
    setConfirming(false);
    setNotice(null);
    onRefresh();
  }

  async function startApplication() {
    if (busy.current || stage !== 'none' || !resume || !accessToken) return;
    busy.current = true;
    setPending('start');
    setError(null);
    setNotice(null);
    try {
      const created = await createApplication(
        { job_id: job.job_id, resume_id: resume.resume_id, mode: 'manual' },
        buildApplicationIdempotencyKey(job.job_id, resume.resume_id),
        accessToken,
      );
      onApplicationChange(created.application);
      setNotice("Application started and saved as a draft in Atlas. Next, apply on the employer's site.");
      setFocusTarget(created.application.status === 'draft' ? 'open' : 'status');
    } catch (cause) {
      // One application per job: a 409 means this user already has one (for another resume, or from another tab).
      if (failureInfo(cause).status === 409) {
        try {
          const existing = await findApplicationForJobId(job.job_id, accessToken);
          if (existing) {
            onApplicationChange(existing);
            setNotice('You already had an application for this job, so we opened it.');
            setFocusTarget(existing.status === 'draft' ? 'open' : 'status');
            return;
          }
        } catch {
          // Fall through to the message below.
        }
      }
      setError({ message: failureMessage('start-application', cause), stale: false });
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  /** Best-effort: the link opens regardless, and a failed marker leaves the application untouched. */
  function handleOpenClick() {
    if (!application || stage !== 'draft' || !accessToken) return;
    setOpenedThisSession(true);
    if (openRecorded.current || recordingOpen.current) return;
    recordingOpen.current = true;
    appendApplicationEvent(application.application_id, { to_status: 'draft', note: OPENED_APPLY_LINK_NOTE }, accessToken)
      .then((response) => {
        openRecorded.current = true;
        setMarkerWarning(null);
        onApplicationChange(mergeApplication(application, response.application));
      })
      .catch((cause: unknown) => setMarkerWarning(failureMessage('record-open', cause)))
      .finally(() => {
        recordingOpen.current = false;
      });
  }

  async function markSubmitted() {
    if (busy.current || stage !== 'draft' || !application || !accessToken) return;
    busy.current = true;
    setPending('submit');
    setError(null);
    try {
      const response = await appendApplicationEvent(
        application.application_id,
        { to_status: 'submitted', note: MARKED_SUBMITTED_NOTE },
        accessToken,
      );
      onApplicationChange(mergeApplication(application, response.application));
      setConfirming(false);
      setNotice('Marked as submitted. You can follow its progress on your Applications page.');
      setFocusTarget('status');
    } catch (cause) {
      setError({ message: failureMessage('mark-submitted', cause), stale: failureInfo(cause).status !== null });
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  const submittedOn = application?.submitted_at ? formatServiceDate(application.submitted_at, { fallback: '' }) : '';

  return (
    <Card role="region" aria-labelledby="apply-title">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
          <SendHorizontal className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
        </div>
        <div>
          <CardTitle id="apply-title" className="text-base">
            Apply to this job
          </CardTitle>
          <CardDescription className="mt-1">
            <strong className="font-medium text-[var(--color-ink)]">Atlas does not submit applications for you.</strong> You
            apply on the employer&apos;s site, then mark it here.
          </CardDescription>
        </div>
      </div>

      {lookup.loading ? (
        <SkeletonGroup label="Checking for an existing application…" className="mt-5">
          <Skeleton className="h-24 w-full" />
        </SkeletonGroup>
      ) : stage === 'tracked' && application ? (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-2">
            <h4
              ref={statusRef}
              tabIndex={-1}
              className="text-sm font-medium text-[var(--color-ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              Application status
            </h4>
            <Badge variant={statusVariant(application.status)}>{statusLabel(application.status)}</Badge>
          </div>
          <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
            {submittedOn ? `Marked as submitted on ${submittedOn}. ` : ''}
            It&apos;s tracked on your Applications page, where its status shows as it changes.
          </p>
          <Button asChild variant="secondary" size="sm" className="mt-4">
            <Link href="/dashboard/applications">View my applications</Link>
          </Button>
        </div>
      ) : (
        <>
          {lookup.failed && stage === 'none' ? (
            <div className="mt-4 rounded-[var(--radius-control)] border border-[var(--color-line-strong)] p-3 text-sm text-[var(--color-ink-soft)]">
              We couldn&apos;t check whether you&apos;ve already started an application for this job. You can still start one;
              if you already have one, we&apos;ll open it.{' '}
              <button
                type="button"
                onClick={refresh}
                className="text-[var(--color-accent)] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                Check again
              </button>
            </div>
          ) : null}

          {jobClosed && stage === 'none' ? (
            <p className="mt-4 text-sm text-[var(--color-warning)]">
              This posting is closed, so an application can&apos;t be started for it.
            </p>
          ) : null}

          <ol className="mt-5 flex flex-col gap-5">
            <Step number={1} title="Start application" done={stage !== 'none'}>
              {stage === 'none' ? (
                <>
                  <p>Saves a draft in Atlas so you can keep track of this job. Nothing is sent to the employer.</p>
                  <Button
                    className="mt-3"
                    onClick={() => void startApplication()}
                    disabled={!resume || availability !== 'ready' || jobClosed || pending !== null}
                    aria-busy={pending === 'start'}
                  >
                    {pending === 'start' ? (
                      <>
                        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                        Starting…
                      </>
                    ) : (
                      'Start application'
                    )}
                  </Button>
                  {resumeStateHint(availability, 'apply') ? (
                    <p className="mt-2 text-xs text-[var(--color-ink-faint)]">{resumeStateHint(availability, 'apply')}</p>
                  ) : null}
                </>
              ) : (
                <p>Draft saved in Atlas.</p>
              )}
            </Step>

            <Step number={2} title="Apply on the employer's site" done={false}>
              {stage !== 'draft' ? (
                <p>Available after you start the application.</p>
              ) : applyUrl ? (
                <>
                  <p>
                    The application form is on the employer&apos;s own site{applyHost ? ` (${applyHost})` : ''}. It opens in a
                    new tab.
                  </p>
                  <Button asChild className="mt-3">
                    <a ref={openLinkRef} href={applyUrl} target="_blank" rel="noopener noreferrer" onClick={handleOpenClick}>
                      Open employer application page
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  </Button>
                  {openedThisSession ? (
                    <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
                      Finish applying in the other tab, then come back here and mark it submitted.
                    </p>
                  ) : null}
                </>
              ) : (
                <p>
                  Atlas doesn&apos;t have an application link for this job. Look for the posting on the employer&apos;s own
                  website, apply there, then come back and mark it submitted.
                </p>
              )}
            </Step>

            <Step number={3} title="Mark it submitted" done={false}>
              {stage !== 'draft' ? (
                <p>Available once the application is started.</p>
              ) : confirming ? (
                <div role="group" aria-labelledby="confirm-submitted-text">
                  <p id="confirm-submitted-text">
                    Mark this application as submitted? This records that you applied on the employer&apos;s site. It
                    can&apos;t be changed back to a draft.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button ref={confirmRef} onClick={() => void markSubmitted()} disabled={pending !== null} aria-busy={pending === 'submit'}>
                      {pending === 'submit' ? (
                        <>
                          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                          Saving…
                        </>
                      ) : (
                        'Yes, I submitted it'
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={pending !== null}
                      onClick={() => {
                        setConfirming(false);
                        setFocusTarget('submit');
                      }}
                    >
                      Not yet
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p>Once you&apos;ve applied on the employer&apos;s site, record it here so your tracker is accurate.</p>
                  <Button
                    ref={submitRef}
                    variant="secondary"
                    className="mt-3"
                    onClick={() => {
                      setConfirming(true);
                      setFocusTarget('confirm');
                    }}
                  >
                    I submitted it
                  </Button>
                </>
              )}
            </Step>
          </ol>
        </>
      )}

      {/* Always mounted so screen readers pick up changes to it. */}
      <p role="status" aria-live="polite" className={notice ? 'mt-4 text-sm text-[var(--color-progress)]' : 'sr-only'}>
        {notice}
      </p>
      {markerWarning ? (
        <p role="status" className="mt-2 text-sm text-[var(--color-warning)]">
          {markerWarning}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mt-4 text-sm text-[var(--color-serious)]">
          <p>{error.message}</p>
          {error.stale ? (
            <Button variant="secondary" size="sm" className="mt-2" onClick={refresh}>
              Refresh status
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
