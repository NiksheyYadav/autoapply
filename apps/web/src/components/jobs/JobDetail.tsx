'use client';

import { AssistedApplyPanel } from '@/components/applications/AssistedApplyPanel';
import { formatServiceDate } from '@/components/applications/timestamp';
import { mergeApplication, type ApplicationItem } from '@/components/applications/view-model';
import { ResumeCheckPanel } from '@/components/resume-check/ResumeCheckPanel';
import { ResumeSection } from '@/components/resume-check/ResumeSection';
import { pickParsedResumes, resumeAvailability, type ResumeState } from '@/components/resume-check/report-view-model';
import { useSession } from '@/lib/auth-context';
import { findApplicationForJobId } from '@/lib/services/applications';
import { listResumes } from '@/lib/services/profile';
import { useResource } from '@/lib/use-resource';
import type { Job } from '@atlas/types';
import { Badge, Card } from '@atlas/ui';
import { Banknote, Briefcase, CalendarDays, Laptop, MapPin } from 'lucide-react';
import * as React from 'react';
import { JobDescription } from './JobDescription';
import { JobMatchSummary } from './JobMatchSummary';
import { employmentTypeLabel, formatSalary, remoteTypeLabel } from './job-view-model';

function MetaItem({ icon: Icon, children }: { icon: typeof MapPin; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      <Icon className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

/**
 * Everything on a job's page below the load/error handling: the posting
 * itself, the resume choice, the resume check and the assisted-apply panel.
 * Rendered only once the job exists, so none of the per-user lookups below run
 * for an id that turned out not to be a job.
 */
export function JobDetail({ job }: { job: Job }) {
  const { accessToken } = useSession();

  const resumes = useResource(() => listResumes(accessToken!), [accessToken]);
  const parsedResumes = React.useMemo(() => pickParsedResumes(resumes.data?.items ?? []), [resumes.data]);
  const availability = resumeAvailability(resumes.data?.items ?? []);
  const resumeState: ResumeState = resumes.loading ? 'loading' : resumes.error !== null ? 'unavailable' : availability;
  const [chosenResumeId, setChosenResumeId] = React.useState<string | null>(null);
  const selectedResume = parsedResumes.find((resume) => resume.resume_id === chosenResumeId) ?? parsedResumes[0] ?? null;

  // Any application this user already has for the job. A fresher copy from an
  // action on the panel (`latest`) wins over the one fetched on load.
  const existing = useResource(() => findApplicationForJobId(job.job_id, accessToken!), [accessToken, job.job_id]);
  const [latest, setLatest] = React.useState<ApplicationItem | null>(null);
  const application = latest ?? existing.data ?? null;

  const salary = formatSalary(job);
  const posted = formatServiceDate(job.posted_at, { fallback: '' });
  // The jobs API returns no company name; it's only known once an application's job summary has been loaded.
  const companyName = application?.job?.company_name ?? null;

  return (
    <div className="mt-4 flex max-w-4xl flex-col gap-6">
      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="break-words font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">{job.title}</h1>
            {companyName ? <p className="mt-1 text-[var(--color-ink-soft)]">{companyName}</p> : null}
            {!job.is_active ? (
              <p className="mt-2">
                <Badge variant="warning">Closed</Badge>
                <span className="ml-2 text-sm text-[var(--color-ink-soft)]">This posting is no longer active.</span>
              </p>
            ) : null}
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-[var(--color-ink-soft)]">
              <MetaItem icon={MapPin}>{job.location ?? 'Location not stated'}</MetaItem>
              <MetaItem icon={Laptop}>{remoteTypeLabel(job.remote_type)}</MetaItem>
              <MetaItem icon={Briefcase}>{employmentTypeLabel(job.employment_type)}</MetaItem>
              {salary ? <MetaItem icon={Banknote}>{salary}</MetaItem> : null}
              {posted ? <MetaItem icon={CalendarDays}>Posted {posted}</MetaItem> : null}
            </ul>
          </div>
          <JobMatchSummary jobId={job.job_id} />
        </div>

        {job.skills.length > 0 ? (
          <div className="mt-5">
            <h2 className="text-sm font-medium text-[var(--color-ink)]">Skills mentioned</h2>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {job.skills.map((skill) => (
                <li key={skill}>
                  <Badge variant="neutral" className="normal-case tracking-normal">
                    {skill}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <JobDescription description={job.description} />

      <ResumeSection
        loading={resumes.loading}
        error={resumes.error !== null}
        onRetry={resumes.reload}
        availability={availability}
        parsedResumes={parsedResumes}
        selectedId={selectedResume?.resume_id ?? null}
        onSelect={setChosenResumeId}
      />

      <ResumeCheckPanel jobId={job.job_id} resume={selectedResume} availability={resumeState} />

      <AssistedApplyPanel
        job={job}
        resume={selectedResume}
        availability={resumeState}
        application={application}
        lookup={{ loading: existing.loading, failed: existing.error !== null }}
        onApplicationChange={(next) => setLatest((previous) => mergeApplication(previous ?? existing.data, next))}
        onRefresh={() => {
          setLatest(null);
          existing.reload();
        }}
      />
    </div>
  );
}
