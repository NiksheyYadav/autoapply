'use client';

import { fadeUp, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import * as React from 'react';

/**
 * Styled like a testimonial slider, but deliberately not one: Atlas has no
 * real users to quote yet, and inventing named people with fabricated
 * first-person quotes would be a fake-review pattern. These are the
 * product's own outcome statements, organized by situation instead of
 * attributed to anyone.
 */
const OUTCOMES = [
  {
    tag: 'The search that stalled out',
    quote:
      'Every open tab was a different job board, a different login, a different spreadsheet row nobody updated. One route, tracked automatically, is the whole point.',
  },
  {
    tag: 'The new grad with 200 tabs open',
    quote: 'Scored and ranked with a reason attached — instead of applying to everything and hoping something sticks.',
  },
  {
    tag: 'The career switch',
    quote:
      "Half your experience doesn't map cleanly onto the title you want next. A real skill match says which half actually does.",
  },
  {
    tag: 'The warm intro that never happens',
    quote:
      "The person worth messaging at a company surfaces the moment you apply — not three weeks later, after the role's filled.",
  },
];

export function Outcomes() {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const dragState = React.useRef({ isDown: false, startX: 0, scrollLeft: 0 });

  function scrollByCard(direction: 1 | -1) {
    const track = trackRef.current;
    if (!track) return;
    const card = track.firstElementChild as HTMLElement | null;
    const amount = (card?.offsetWidth ?? 400) + 24;
    track.scrollBy({ left: amount * direction, behavior: 'smooth' });
  }

  function handleMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    const track = trackRef.current;
    if (!track) return;
    dragState.current = { isDown: true, startX: event.pageX - track.offsetLeft, scrollLeft: track.scrollLeft };
  }

  function endDrag() {
    dragState.current.isDown = false;
  }

  function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    const track = trackRef.current;
    if (!track || !dragState.current.isDown) return;
    event.preventDefault();
    const x = event.pageX - track.offsetLeft;
    const walk = (x - dragState.current.startX) * 1.5;
    track.scrollLeft = dragState.current.scrollLeft - walk;
  }

  return (
    <section className="px-6 py-20">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          variants={fadeUp}
          className="mb-10 flex items-end justify-between"
        >
          <h2 className="font-[var(--font-display)] text-3xl font-medium text-[var(--color-ink)] md:text-4xl">
            What changes for you
          </h2>
          <div className="hidden gap-2 md:flex">
            <button
              type="button"
              onClick={() => scrollByCard(-1)}
              aria-label="Previous"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--color-line-strong)] transition-colors hover:bg-white/5"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => scrollByCard(1)}
              aria-label="Next"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--color-line-strong)] transition-colors hover:bg-white/5"
            >
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </motion.div>

        <div
          ref={trackRef}
          onMouseDown={handleMouseDown}
          onMouseLeave={endDrag}
          onMouseUp={endDrag}
          onMouseMove={handleMouseMove}
          className="atlas-no-scrollbar flex cursor-grab snap-x snap-mandatory gap-6 overflow-x-auto pb-4 active:cursor-grabbing"
        >
          {OUTCOMES.map((outcome) => (
            <div
              key={outcome.tag}
              className="w-[85vw] shrink-0 snap-center rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-10 transition-colors duration-500 hover:border-[var(--color-accent)]/30 md:w-[440px]"
            >
              <div className="mb-6 font-[var(--font-display)] text-5xl text-[var(--color-accent)]">&ldquo;</div>
              <p className="font-[var(--font-display)] text-xl leading-snug text-[var(--color-ink)] md:text-2xl">{outcome.quote}</p>
              <div className="mt-8 font-[var(--font-mono)] text-xs uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
                {outcome.tag}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
