'use client';

import { Button, Card, CardTitle } from '@atlas/ui';
import { ChevronDown } from 'lucide-react';
import * as React from 'react';
import { descriptionToParagraphs, paragraphsLength } from './job-view-model';

/** Below this many characters the whole description is shown with no toggle. */
const COLLAPSE_THRESHOLD = 1400;

export function JobDescription({ description }: { description: string | null }) {
  const paragraphs = React.useMemo(() => descriptionToParagraphs(description), [description]);
  const collapsible = paragraphsLength(paragraphs) > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = React.useState(false);
  const collapsed = collapsible && !expanded;

  return (
    <Card role="region" aria-labelledby="job-description-title">
      <CardTitle id="job-description-title" className="text-base">
        About this role
      </CardTitle>
      {paragraphs.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
          This posting doesn&apos;t include a description. The employer&apos;s own page may have more detail.
        </p>
      ) : (
        <>
          <div
            id="job-description-body"
            className={
              collapsed
                ? 'relative mt-3 max-h-72 space-y-4 overflow-hidden text-sm leading-relaxed text-[var(--color-ink-soft)] [mask-image:linear-gradient(to_bottom,black_65%,transparent)]'
                : 'mt-3 space-y-4 text-sm leading-relaxed text-[var(--color-ink-soft)]'
            }
          >
            {paragraphs.map((paragraph, index) => (
              <p key={`${index}:${paragraph.slice(0, 24)}`} className="whitespace-pre-line break-words">
                {paragraph}
              </p>
            ))}
          </div>
          {collapsible ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 -ml-3"
              aria-expanded={expanded}
              aria-controls="job-description-body"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Show less' : 'Show full description'}
              <ChevronDown className={expanded ? 'h-4 w-4 rotate-180' : 'h-4 w-4'} aria-hidden="true" />
            </Button>
          ) : null}
        </>
      )}
    </Card>
  );
}
