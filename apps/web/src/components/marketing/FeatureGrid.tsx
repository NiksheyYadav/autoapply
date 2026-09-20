'use client';

import { Card, MagneticHover, fadeUp, staggerContainer, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';
import { FileSearch, MapPinned, SendHorizontal, Users } from 'lucide-react';

export function FeatureGrid() {
  return (
    <section id="features" className="px-6 py-20">
      <div className="mx-auto max-w-6xl">
        <motion.div initial="hidden" whileInView="visible" viewport={viewportOnce} variants={fadeUp} className="mb-16 text-center">
          <h2 className="font-[var(--font-display)] text-4xl font-medium text-[var(--color-ink)] md:text-5xl">
            Less noise. More signal.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-[var(--color-ink-soft)]">
            Four things, done properly, instead of forty things done halfway.
          </p>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          variants={staggerContainer}
          className="grid grid-cols-1 gap-4 md:grid-cols-3"
        >
          <motion.div variants={fadeUp} className="md:col-span-2">
            <MagneticHover strength={6} className="block h-full w-full">
              <Card interactive className="relative h-full overflow-hidden p-10">
                <div className="absolute top-0 right-0 h-64 w-64 rounded-full bg-[var(--color-accent)]/5 blur-3xl" />
                <div className="relative z-10">
                  <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--color-accent)]/20 bg-[var(--color-accent-soft)]">
                    <FileSearch className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={2} />
                  </div>
                  <h3 className="mb-3 text-2xl font-medium text-[var(--color-ink)]">Your resume, finally readable.</h3>
                  <p className="max-w-md leading-relaxed text-[var(--color-ink-soft)]">
                    Machines read it before a person ever does. We make sure it says what you meant — and tell you,
                    plainly, when it doesn't.
                  </p>
                </div>
              </Card>
            </MagneticHover>
          </motion.div>

          <motion.div variants={fadeUp}>
            <MagneticHover strength={6} className="block h-full w-full">
              <Card interactive className="h-full p-10">
                <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--color-line-strong)] bg-white/5">
                  <MapPinned className="h-5 w-5 text-[var(--color-ink)]" strokeWidth={2} />
                </div>
                <h3 className="mb-3 text-xl font-medium text-[var(--color-ink)]">Every match, explained.</h3>
                <p className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
                  Not a score. A reason. You should never have to guess why a job showed up.
                </p>
              </Card>
            </MagneticHover>
          </motion.div>

          <motion.div variants={fadeUp}>
            <MagneticHover strength={6} className="block h-full w-full">
              <Card interactive className="h-full p-10">
                <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--color-line-strong)] bg-white/5">
                  <SendHorizontal className="h-5 w-5 text-[var(--color-ink)]" strokeWidth={2} />
                </div>
                <h3 className="mb-3 text-xl font-medium text-[var(--color-ink)]">Applied once. Tracked forever.</h3>
                <p className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
                  No spreadsheet. No "did I already apply here?" Just the truth, always current.
                </p>
              </Card>
            </MagneticHover>
          </motion.div>

          <motion.div variants={fadeUp} className="md:col-span-2">
            <MagneticHover strength={6} className="block h-full w-full">
              <Card interactive className="flex h-full items-center gap-8 p-10">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-[var(--color-accent)]/20 bg-[var(--color-accent-soft)]">
                  <Users className="h-6 w-6 text-[var(--color-accent)]" strokeWidth={2} />
                </div>
                <div>
                  <h3 className="mb-2 text-xl font-medium text-[var(--color-ink)]">The right person, found for you.</h3>
                  <p className="text-sm leading-relaxed text-[var(--color-ink-soft)]">
                    The moment you apply, we find who can actually vouch for you there. Not a stranger. Someone real.
                  </p>
                </div>
              </Card>
            </MagneticHover>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
