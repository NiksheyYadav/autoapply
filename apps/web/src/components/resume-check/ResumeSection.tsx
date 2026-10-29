'use client';

import { Button, Card, CardDescription, CardTitle, Label, Skeleton } from '@atlas/ui';
import type { Resume } from '@atlas/types';
import Link from 'next/link';
import { SkeletonGroup } from '@/components/dashboard/SkeletonGroup';
import { ResourceError } from '@/components/dashboard/ResourceError';
import { resumeOptionLabel, type ResumeAvailability } from './report-view-model';

const SELECT_CLASSES =
  'h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-[var(--color-canvas-raised)] px-3.5 text-sm text-[var(--color-ink)] outline-none transition-colors focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20 disabled:opacity-50';

export interface ResumeSectionProps {
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  availability: ResumeAvailability;
  /** Parsed resumes only, newest first. */
  parsedResumes: Resume[];
  selectedId: string | null;
  onSelect: (resumeId: string) => void;
}

/**
 * Which resume the check and the application use. The default is the most
 * recent parsed one; the picker only appears when there is a real choice.
 */
export function ResumeSection({
  loading,
  error,
  onRetry,
  availability,
  parsedResumes,
  selectedId,
  onSelect,
}: ResumeSectionProps) {
  if (loading) {
    return (
      <Card>
        <SkeletonGroup label="Loading your resumes…">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-3 h-11 w-full" />
        </SkeletonGroup>
      </Card>
    );
  }

  if (error) return <ResourceError what="your resumes" onRetry={onRetry} />;

  if (availability !== 'ready') {
    const copy = {
      none: {
        title: 'Upload a resume first',
        body: 'The resume check and your application both need a resume. Upload one and Atlas will read it, which usually takes a moment.',
        action: 'Upload a resume',
      },
      processing: {
        title: 'Your resume is still being processed',
        body: 'You can check it against this job and apply with it once processing has finished. This usually takes a moment.',
        action: 'See your resume',
      },
      failed: {
        title: "We couldn't read your resume",
        body: 'None of your uploaded resumes could be processed. Open your Resume page to see why, or upload a different file (PDF, DOCX, or TXT).',
        action: 'Go to your resume',
      },
    }[availability];

    return (
      <Card>
        <CardTitle className="text-base">{copy.title}</CardTitle>
        <CardDescription className="mt-1">{copy.body}</CardDescription>
        <Button asChild variant="secondary" size="sm" className="mt-4">
          <Link href="/dashboard/resume">{copy.action}</Link>
        </Button>
      </Card>
    );
  }

  const selected = parsedResumes.find((resume) => resume.resume_id === selectedId) ?? parsedResumes[0];

  return (
    <Card>
      <CardTitle className="text-base">Your resume</CardTitle>
      {parsedResumes.length > 1 ? (
        <div className="mt-3">
          <Label htmlFor="job-resume-select">Resume to use for the check and your application</Label>
          <select
            id="job-resume-select"
            className={SELECT_CLASSES}
            value={selected?.resume_id ?? ''}
            onChange={(event) => onSelect(event.target.value)}
          >
            {parsedResumes.map((resume, index) => (
              <option key={resume.resume_id} value={resume.resume_id}>
                {resumeOptionLabel(resume)}
                {index === 0 ? ' — most recent' : ''}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <CardDescription className="mt-1">
          Using <span className="font-medium text-[var(--color-ink)]">{selected?.original_filename}</span> for the check and
          your application.{' '}
          <Link href="/dashboard/resume" className="text-[var(--color-accent)] underline underline-offset-2">
            Manage resumes
          </Link>
        </CardDescription>
      )}
    </Card>
  );
}
