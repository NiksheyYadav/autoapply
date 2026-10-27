'use client';

import { useSession } from '@/lib/auth-context';
import { optimizeResume } from '@/lib/services/profile';
import { Button, Card, CardDescription, CardTitle } from '@atlas/ui';
import type { Resume } from '@atlas/types';
import { FileSearch, LoaderCircle } from 'lucide-react';
import * as React from 'react';
import { failureMessage } from '../applications/failure-message';
import { resumeStateHint, toReportViewModel, type ReportViewModel, type ResumeState } from './report-view-model';
import { ResumeReport } from './ResumeReport';

type CheckState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'error'; message: string }
  | { phase: 'done'; resumeId: string; view: ReportViewModel };

export interface ResumeCheckPanelProps {
  jobId: string;
  /** The resume chosen in the section above; null when there is nothing checkable. */
  resume: Resume | null;
  availability: ResumeState;
}

/**
 * "Check my resume against this job". Calls the advisory optimize endpoint and
 * shows what it says. It reports; it never edits the resume, and nothing on
 * this panel should read as though it does.
 */
export function ResumeCheckPanel({ jobId, resume, availability }: ResumeCheckPanelProps) {
  const { accessToken } = useSession();
  const [state, setState] = React.useState<CheckState>({ phase: 'idle' });
  const resultHeadingRef = React.useRef<HTMLHeadingElement>(null);
  // Only the latest request may update the panel (the user can switch resume mid-flight).
  const requestId = React.useRef(0);
  const resumeId = resume?.resume_id ?? null;

  // A result belongs to one resume. Switching resume (or job) discards it rather than showing it under the wrong name.
  React.useEffect(() => {
    requestId.current += 1;
    setState({ phase: 'idle' });
  }, [resumeId, jobId]);

  React.useEffect(() => {
    if (state.phase === 'done') resultHeadingRef.current?.focus();
  }, [state]);

  async function runCheck() {
    if (!resumeId || !accessToken || state.phase === 'running') return;
    const mine = ++requestId.current;
    setState({ phase: 'running' });
    try {
      const response = await optimizeResume(resumeId, jobId, accessToken);
      if (mine !== requestId.current) return;
      setState({ phase: 'done', resumeId, view: toReportViewModel(response.report) });
    } catch (cause) {
      if (mine !== requestId.current) return;
      setState({ phase: 'error', message: failureMessage('resume-check', cause) });
    }
  }

  const running = state.phase === 'running';
  const canRun = availability === 'ready' && resume !== null;

  return (
    <Card role="region" aria-labelledby="resume-check-title">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
          <FileSearch className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
        </div>
        <div>
          <CardTitle id="resume-check-title" className="text-base">
            Check my resume against this job
          </CardTitle>
          <CardDescription className="mt-1">
            Compares your resume with this posting&apos;s keywords and flags bullets that read weakly. It&apos;s advice only:
            Atlas never edits your resume or adds anything to it.
          </CardDescription>
        </div>
      </div>

      <div className="mt-4">
        <Button onClick={() => void runCheck()} disabled={!canRun || running} aria-busy={running}>
          {running ? (
            <>
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              Checking…
            </>
          ) : state.phase === 'done' || state.phase === 'error' ? (
            'Check again'
          ) : (
            'Check my resume'
          )}
        </Button>
        {resumeStateHint(availability, 'check') ? (
          <p className="mt-2 text-xs text-[var(--color-ink-faint)]">{resumeStateHint(availability, 'check')}</p>
        ) : null}
        {canRun && state.phase === 'idle' && resume ? (
          <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
            Will check <span className="text-[var(--color-ink-soft)]">{resume.original_filename}</span>.
          </p>
        ) : null}
      </div>

      {/* Announced politely while the request is in flight; results take focus instead. */}
      <p role="status" aria-live="polite" className={running ? 'mt-3 text-sm text-[var(--color-ink-soft)]' : 'sr-only'}>
        {running ? 'Checking your resume against this job…' : ''}
      </p>

      {state.phase === 'error' ? (
        <p role="alert" className="mt-3 text-sm text-[var(--color-serious)]">
          {state.message}
        </p>
      ) : null}

      {state.phase === 'done' ? <ResumeReport ref={resultHeadingRef} view={state.view} /> : null}
    </Card>
  );
}
