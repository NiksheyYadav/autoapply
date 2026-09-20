'use client';

import { Card, fadeUp, viewportOnce } from '@atlas/ui';
import { AnimatePresence, motion } from 'framer-motion';
import { Quote } from 'lucide-react';
import * as React from 'react';

/**
 * Styled like a testimonial slider, but deliberately not one: Atlas has no
 * real users to quote yet, and inventing named people with fabricated
 * quotes would be a fake-review pattern. These are the product's own
 * outcome statements, organized by situation instead of attributed to
 * anyone.
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
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    const id = setInterval(() => setIndex((current) => (current + 1) % OUTCOMES.length), 5000);
    return () => clearInterval(id);
  }, []);

  const current = OUTCOMES[index];

  return (
    <section className="px-6 py-20">
      <div className="mx-auto max-w-3xl">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          variants={fadeUp}
          className="mb-10 text-center"
        >
          <h2 className="font-[var(--font-display)] text-3xl font-medium text-[var(--color-ink)]">What changes for you</h2>
        </motion.div>

        <Card className="relative overflow-hidden px-8 py-10 text-center sm:px-14">
          <Quote className="mx-auto mb-5 h-8 w-8 text-[var(--color-accent)]" strokeWidth={1.5} />
          <AnimatePresence mode="wait">
            <motion.div
              key={index}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.4 }}
            >
              <p className="font-[var(--font-display)] text-xl leading-relaxed text-[var(--color-ink)] md:text-2xl">
                “{current?.quote}”
              </p>
              <p className="mt-5 font-[var(--font-mono)] text-xs uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
                {current?.tag}
              </p>
            </motion.div>
          </AnimatePresence>
        </Card>

        <div className="mt-6 flex items-center justify-center gap-2">
          {OUTCOMES.map((outcome, i) => (
            <button
              key={outcome.tag}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Show: ${outcome.tag}`}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? 'w-6 bg-[var(--color-accent)]' : 'w-1.5 bg-[var(--color-line-strong)]'
              }`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
