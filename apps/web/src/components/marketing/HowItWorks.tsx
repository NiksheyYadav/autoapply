'use client';

import { Badge, fadeUp, staggerContainer, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';

const STEPS = [
  { title: 'Upload your resume', detail: 'PDF, DOCX, or plain text. Parsed into structured skills and experience in seconds.' },
  { title: 'Get scored recommendations', detail: 'Every active job gets a 0–100 match score with the specific reasons behind it.' },
  { title: 'Apply with one idempotent click', detail: 'A retried submission never double-applies — the platform guarantees it.' },
  { title: 'Let Atlas find your in', detail: 'Contacts at that company surface automatically the moment you apply.' },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="px-6 py-20">
      <div className="mx-auto max-w-4xl">
        <motion.div initial="hidden" whileInView="visible" viewport={viewportOnce} variants={fadeUp} className="mb-14 text-center">
          <h2 className="font-[var(--font-display)] text-3xl font-medium text-[var(--color-ink)]">How it works</h2>
        </motion.div>

        <motion.ol
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          variants={staggerContainer}
          className="relative border-l border-[var(--color-line)] pl-10"
        >
          {STEPS.map((step, index) => (
            <motion.li key={step.title} variants={fadeUp} className="relative mb-10 last:mb-0">
              <span className="absolute -left-[3.25rem] top-0 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-line-strong)] bg-[var(--color-surface)]">
                <Badge variant="accent" className="h-full w-full items-center justify-center rounded-full p-0">
                  {index + 1}
                </Badge>
              </span>
              <h3 className="font-[var(--font-display)] text-lg font-medium text-[var(--color-ink)]">{step.title}</h3>
              <p className="mt-1.5 text-[var(--color-ink-soft)]">{step.detail}</p>
            </motion.li>
          ))}
        </motion.ol>
      </div>
    </section>
  );
}
