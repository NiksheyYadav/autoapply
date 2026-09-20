'use client';

import { Card, fadeUp, staggerContainer, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';
import { FileSearch, MapPinned, SendHorizontal, Users } from 'lucide-react';

export function FeatureGrid() {
  return (
    <section id="features" className="px-6 py-20">
      <div className="mx-auto max-w-6xl">
        <motion.h2
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          variants={fadeUp}
          className="mb-16 text-center font-[var(--font-display)] text-4xl font-medium text-[var(--color-ink)] md:text-5xl"
        >
          Engineered for precision.
        </motion.h2>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          variants={staggerContainer}
          className="grid grid-cols-1 gap-4 md:grid-cols-3"
        >
          <motion.div variants={fadeUp} className="md:col-span-2">
            <Card interactive className="relative h-full overflow-hidden p-10">
              <div className="absolute top-0 right-0 h-64 w-64 rounded-full bg-[var(--color-accent)]/5 blur-3xl" />
              <div className="relative z-10">
                <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--color-accent)]/20 bg-[var(--color-accent-soft)]">
                  <FileSearch className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={2} />
                </div>
                <h3 className="mb-3 text-2xl font-medium text-[var(--color-ink)]">Resume parsing & ATS scoring</h3>
                <p className="max-w-md leading-relaxed text-[var(--color-ink-soft)]">
                  Skills, experience, and gaps extracted automatically, scored against what actually gets past a screener.
                  No black boxes, just plain-English reasoning.
                </p>
              </div>
            </Card>
          </motion.div>

          <motion.div variants={fadeUp}>
            <Card interactive className="h-full p-10">
              <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--color-line-strong)] bg-white/5">
                <MapPinned className="h-5 w-5 text-[var(--color-ink)]" strokeWidth={2} />
              </div>
              <h3 className="mb-3 text-xl font-medium text-[var(--color-ink)]">Matching, not keyword-stuffing</h3>
              <p className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
                Every open role gets a real compatibility score and a plain-English reason.
              </p>
            </Card>
          </motion.div>

          <motion.div variants={fadeUp}>
            <Card interactive className="h-full p-10">
              <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--color-line-strong)] bg-white/5">
                <SendHorizontal className="h-5 w-5 text-[var(--color-ink)]" strokeWidth={2} />
              </div>
              <h3 className="mb-3 text-xl font-medium text-[var(--color-ink)]">Applications that track themselves</h3>
              <p className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
                One submission, a full lifecycle trail, and a status that never silently goes stale.
              </p>
            </Card>
          </motion.div>

          <motion.div variants={fadeUp} className="md:col-span-2">
            <Card interactive className="flex h-full items-center gap-8 p-10">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-[var(--color-accent)]/20 bg-[var(--color-accent-soft)]">
                <Users className="h-6 w-6 text-[var(--color-accent)]" strokeWidth={2} />
              </div>
              <div>
                <h3 className="mb-2 text-xl font-medium text-[var(--color-ink)]">Referrals found automatically</h3>
                <p className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
                  The moment you apply, Atlas checks who you already half-know at that company.
                </p>
              </div>
            </Card>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
