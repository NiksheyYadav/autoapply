'use client';

import { Marquee, fadeUp, viewportOnce } from '@atlas/ui';
import { motion } from 'framer-motion';

/**
 * Simple geometric glyphs, not logo reproductions — same spirit as the
 * reference mockup, which used generic placeholder icons next to each
 * name rather than pixel-accurate brand marks. `currentColor`-based so the
 * hover color swap on the wrapping element carries through automatically.
 */
function RingGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}
function GridGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <rect x="3" y="3" width="8" height="8" /><rect x="13" y="3" width="8" height="8" />
      <rect x="3" y="13" width="8" height="8" /><rect x="13" y="13" width="8" height="8" />
    </svg>
  );
}
function TriangleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 3L22 20H2L12 3Z" />
    </svg>
  );
}
function InfinityGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <circle cx="8" cy="12" r="5" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="16" cy="12" r="5" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}
function DiamondGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2L22 12L12 22L2 12L12 2Z" />
    </svg>
  );
}
function BarsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <rect x="3" y="3" width="4" height="18" /><rect x="10" y="3" width="4" height="18" /><rect x="17" y="3" width="4" height="18" />
    </svg>
  );
}
function HexGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <path d="M12 2L21 7.5V16.5L12 22L3 16.5V7.5L12 2Z" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}
function SlashGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <path d="M18 4L6 20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
function ArcGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <path d="M4 15C7 20 17 20 20 15" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
function SquareGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}

const ROW_ONE = [
  { name: 'Google', Glyph: RingGlyph },
  { name: 'Microsoft', Glyph: GridGlyph },
  { name: 'Amazon', Glyph: ArcGlyph },
  { name: 'Stripe', Glyph: SlashGlyph },
  { name: 'Vercel', Glyph: TriangleGlyph },
];
const ROW_TWO = [
  { name: 'Meta', Glyph: InfinityGlyph },
  { name: 'Apple', Glyph: SquareGlyph },
  { name: 'OpenAI', Glyph: HexGlyph },
  { name: 'Linear', Glyph: BarsGlyph },
  { name: 'Netflix', Glyph: DiamondGlyph },
];

function MarqueeRow({ companies, reverse }: { companies: typeof ROW_ONE; reverse: boolean }) {
  return (
    <Marquee durationSeconds={34} reverse={reverse}>
      <div className="flex items-center gap-16 px-8">
        {companies.map(({ name, Glyph }) => (
          <div key={name} className="group flex items-center gap-2.5 whitespace-nowrap text-[var(--color-ink-faint)] transition-all duration-300 hover:scale-110 hover:text-[var(--color-accent)]">
            <Glyph className="h-5 w-5 shrink-0" />
            <span className="font-[var(--font-display)] text-lg font-medium">{name}</span>
          </div>
        ))}
      </div>
    </Marquee>
  );
}

export function CompanyMarquee() {
  return (
    <section className="border-y border-white/[0.03] bg-[var(--color-canvas-raised)]/40 py-10">
      <motion.p
        initial="hidden"
        whileInView="visible"
        viewport={viewportOnce}
        variants={fadeUp}
        className="mb-6 text-center font-[var(--font-mono)] text-xs uppercase tracking-[0.18em] text-[var(--color-ink-faint)]"
      >
        Where the people using Atlas work
      </motion.p>
      <div className="flex flex-col gap-6">
        <MarqueeRow companies={ROW_ONE} reverse={false} />
        <MarqueeRow companies={ROW_TWO} reverse />
      </div>
    </section>
  );
}
