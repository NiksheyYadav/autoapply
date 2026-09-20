'use client';

import { Marquee, fadeUp, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';

/**
 * Fictional employer names, not real companies or logos — Atlas has no
 * signed customers to name-drop yet (jobs are ingested via an admin API,
 * not a live pipeline), so a real-company wall would imply an endorsement
 * or dataset that doesn't exist. This stays illustrative, and says so.
 */
const ROW_ONE = ['Northwind Systems', 'Fernbank Health', 'Loop Analytics', 'Halcyon Robotics', 'Ridgeline Capital'];
const ROW_TWO = ['Corvus Logistics', 'Meridian Foods', 'Tidewater Labs', 'Arclight Energy', 'Basecamp Materials'];

function MarqueeRow({ names, muted, reverse }: { names: string[]; muted: boolean; reverse: boolean }) {
  return (
    <Marquee durationSeconds={34} reverse={reverse}>
      <div className={`flex items-center gap-12 px-6 font-[var(--font-mono)] text-sm tracking-widest uppercase ${muted ? 'text-[var(--color-ink-faint)]/60' : 'text-[var(--color-ink-faint)]'}`}>
        {names.map((name) => (
          <span key={name} className="flex items-center gap-12 whitespace-nowrap">
            {name}
            <span className="text-[var(--color-accent)]/40">&bull;</span>
          </span>
        ))}
      </div>
    </Marquee>
  );
}

export function CompanyMarquee() {
  return (
    <section className="border-y border-[var(--color-line)] bg-[var(--color-canvas-raised)]/40 py-10">
      <motion.p
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
        variants={fadeUp}
        className="mb-6 text-center font-[var(--font-mono)] text-xs uppercase tracking-[0.18em] text-[var(--color-ink-faint)]"
      >
        Roles span every kind of employer
      </motion.p>
      <div className="flex flex-col gap-5">
        <MarqueeRow names={ROW_ONE} muted={false} reverse={false} />
        <MarqueeRow names={ROW_TWO} muted reverse />
      </div>
      <p className="mt-6 text-center text-xs text-[var(--color-ink-faint)]">Illustrative examples — not live Atlas customers.</p>
    </section>
  );
}
