'use client';

import { Card, CardDescription, CardTitle, fadeUp, staggerContainer, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';
import { FileSearch, MapPinned, SendHorizontal, Users } from 'lucide-react';

const FEATURES = [
  {
    icon: FileSearch,
    title: 'Resume parsing & ATS scoring',
    description: 'Skills, experience, and gaps extracted automatically, scored against what actually gets past a screener.',
  },
  {
    icon: MapPinned,
    title: 'Matching, not keyword-stuffing',
    description: "Every open role gets a real compatibility score and a plain-English reason, not a black box.",
  },
  {
    icon: SendHorizontal,
    title: 'Applications that track themselves',
    description: 'One submission, a full lifecycle trail, and a status that never silently goes stale.',
  },
  {
    icon: Users,
    title: 'Referrals found automatically',
    description: 'The moment you apply, Atlas checks who you already half-know at that company.',
  },
];

export function FeatureGrid() {
  return (
    <section id="features" className="px-6 py-20">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          variants={fadeUp}
          className="mb-12 max-w-lg"
        >
          <h2 className="font-[var(--font-display)] text-3xl font-medium text-[var(--color-ink)]">
            Four agents. One search.
          </h2>
          <p className="mt-3 text-[var(--color-ink-soft)]">
            Each step in the pipeline is a small, honest piece of automation — no step pretends to do more than it does.
          </p>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={viewportOnce}
          variants={staggerContainer}
          className="grid gap-5 sm:grid-cols-2"
        >
          {FEATURES.map((feature) => (
            <motion.div key={feature.title} variants={fadeUp}>
              <Card interactive className="h-full">
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
                  <feature.icon className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={2} />
                </div>
                <CardTitle>{feature.title}</CardTitle>
                <CardDescription className="mt-2">{feature.description}</CardDescription>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
