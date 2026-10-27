'use client';

import { Badge, Button, ProgressRing } from '@atlas/ui';
import { Info } from 'lucide-react';
import * as React from 'react';
import type { KeywordBand, ReportViewModel } from './report-view-model';

const INITIAL_FINDINGS = 5;

const BAND_BADGE: Record<KeywordBand, 'progress' | 'warning' | 'serious' | 'neutral'> = {
  strong: 'progress',
  partial: 'warning',
  weak: 'serious',
  none: 'neutral',
};

function SectionHeading({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h5 className="text-sm font-medium text-[var(--color-ink)]">
      {children}
      {count !== undefined ? <span className="ml-1.5 font-normal text-[var(--color-ink-faint)]">({count})</span> : null}
    </h5>
  );
}

function KeywordList({ keywords, variant }: { keywords: string[]; variant: 'progress' | 'warning' }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {keywords.map((keyword) => (
        <li key={keyword}>
          <Badge variant={variant} className="normal-case tracking-normal">
            {keyword}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * The result of one resume check. Everything here is advice about the resume
 * the user already has: it names keywords the posting uses and bullets that
 * read weakly, and never presents replacement text.
 */
export const ResumeReport = React.forwardRef<HTMLHeadingElement, { view: ReportViewModel }>(function ResumeReport(
  { view },
  headingRef,
) {
  const [showAllFindings, setShowAllFindings] = React.useState(false);
  const findings = showAllFindings ? view.bulletFindings : view.bulletFindings.slice(0, INITIAL_FINDINGS);
  const hiddenFindings = view.bulletFindings.length - findings.length;

  return (
    <div className="mt-6 flex flex-col gap-6 border-t border-[var(--color-line)] pt-6">
      <h4
        ref={headingRef}
        tabIndex={-1}
        className="font-[var(--font-display)] text-lg font-medium text-[var(--color-ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        Resume check results
      </h4>

      <section aria-labelledby="rc-keywords" className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          {view.keywordScore !== null ? <ProgressRing value={view.keywordScore} size={72} strokeWidth={7} label="match" /> : null}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h5 id="rc-keywords" className="text-sm font-medium text-[var(--color-ink)]">
                Keyword match
              </h5>
              <Badge variant={BAND_BADGE[view.band]}>{view.bandLabel}</Badge>
            </div>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{view.keywordSummary}</p>
          </div>
        </div>

        {view.matched.length > 0 ? (
          <div>
            <SectionHeading count={view.matched.length}>Keywords your resume already covers</SectionHeading>
            <KeywordList keywords={view.matched} variant="progress" />
          </div>
        ) : null}

        {view.missing.length > 0 ? (
          <div>
            <SectionHeading count={view.missing.length}>Keywords this posting uses that your resume doesn&apos;t</SectionHeading>
            <KeywordList keywords={view.missing} variant="warning" />
            <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
              Only add a keyword if it&apos;s true for you. A missing keyword isn&apos;t a reason to claim experience you
              don&apos;t have.
            </p>
          </div>
        ) : null}
      </section>

      {view.recommendations.length > 0 ? (
        <section aria-labelledby="rc-recommendations">
          <h5 id="rc-recommendations" className="text-sm font-medium text-[var(--color-ink)]">
            Suggestions
          </h5>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-[var(--color-ink-soft)]">
            {view.recommendations.map((line, index) => (
              <li key={`${index}:${line}`}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="rc-bullets">
        <h5 id="rc-bullets" className="text-sm font-medium text-[var(--color-ink)]">
          Bullets worth a second look
          <span className="ml-1.5 font-normal text-[var(--color-ink-faint)]">({view.bulletFindings.length})</span>
        </h5>
        {view.bulletFindings.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-ink-soft)]">We didn&apos;t flag any bullets in your resume.</p>
        ) : (
          <>
            <ul className="mt-3 flex flex-col gap-3">
              {findings.map((finding) => (
                <li key={finding.key} className="rounded-[var(--radius-control)] border border-[var(--color-line)] p-4">
                  {finding.where ? <p className="text-xs text-[var(--color-ink-faint)]">{finding.where}</p> : null}
                  <blockquote className="mt-1 break-words border-l-2 border-[var(--color-line-strong)] pl-3 text-sm text-[var(--color-ink)]">
                    {finding.bullet}
                  </blockquote>
                  <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Issues found">
                    {finding.issues.map((issue) => (
                      <li key={issue}>
                        <Badge variant="warning" className="normal-case tracking-normal">
                          {issue}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--color-ink-soft)]">
                    {finding.suggestions.map((suggestion, index) => (
                      <li key={`${index}:${suggestion}`}>{suggestion}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {hiddenFindings > 0 ? (
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => setShowAllFindings(true)}>
                Show {hiddenFindings} more
              </Button>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="rc-ats">
        <h5 id="rc-ats" className="text-sm font-medium text-[var(--color-ink)]">
          ATS readiness
          {view.atsScore !== null ? (
            <span className="ml-1.5 font-normal text-[var(--color-ink-faint)]">({view.atsScore}/100)</span>
          ) : null}
        </h5>
        <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
          This describes your resume overall, not this job. It&apos;s the same score shown on your Resume page.
        </p>
        {view.atsIssues.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-ink-soft)]">No formatting or structure problems found.</p>
        ) : (
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-[var(--color-ink-soft)]">
            {view.atsIssues.map((issue, index) => (
              <li key={`${index}:${issue.label}`}>
                <span className="font-medium text-[var(--color-ink)]">{issue.label}.</span> {issue.hint}
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside
        aria-label="About these suggestions"
        className="flex gap-3 rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-white/[0.03] p-4"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
        <p className="text-sm text-[var(--color-ink-soft)]">{view.truthfulnessNote}</p>
      </aside>
    </div>
  );
});
