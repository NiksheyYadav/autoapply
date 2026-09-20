'use client';

import { motion } from 'framer-motion';
import * as React from 'react';

const AGENTS = [
  { label: 'Parse', delay: '0s' },
  { label: 'Score', delay: '-3s' },
  { label: 'Match', delay: '-6s' },
  { label: 'Refer', delay: '-9s' },
];

/**
 * The hero's centerpiece: a central node with the four pipeline-stage
 * agents orbiting it, tied together by two static rings. This replaces
 * RoutePath in the hero specifically — RoutePath's map motif still shows up
 * elsewhere (AuthShell), this is the flashier, more literal "four agents"
 * visual the new hero copy is built around.
 */
export function AgentOrbit() {
  return (
    <div className="relative flex h-[420px] items-center justify-center sm:h-[480px]" aria-hidden="true">
      <motion.div
        className="absolute h-72 w-72 rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(229,160,13,0.18) 0%, transparent 70%)' }}
        animate={{ scale: [1, 1.08, 1], opacity: [0.5, 0.75, 0.5] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative z-20 flex h-24 w-24 items-center justify-center rounded-full border border-[var(--color-accent)]/50 bg-[var(--color-surface)] shadow-[0_0_50px_-10px_var(--color-accent)]">
        <span className="font-[var(--font-display)] text-3xl text-[var(--color-accent)]">A</span>
      </div>

      <div className="absolute flex h-full w-full items-center justify-center">
        {AGENTS.map((agent) => (
          <div
            key={agent.label}
            className="atlas-orbit absolute flex h-16 w-16 items-center justify-center rounded-full border border-[var(--color-line-strong)] bg-[var(--color-surface)]"
            style={
              {
                '--atlas-orbit-radius': '150px',
                '--atlas-orbit-duration': '12s',
                '--atlas-orbit-delay': agent.delay,
              } as React.CSSProperties
            }
          >
            <span className="font-[var(--font-mono)] text-[10px] uppercase tracking-widest text-[var(--color-ink-faint)]">
              {agent.label}
            </span>
          </div>
        ))}
      </div>

      <svg className="absolute inset-0 h-full w-full opacity-30">
        <circle cx="50%" cy="50%" r="150" stroke="var(--color-accent)" strokeOpacity="0.25" strokeWidth="1" fill="none" strokeDasharray="4 4" />
        <circle cx="50%" cy="50%" r="190" stroke="white" strokeOpacity="0.06" strokeWidth="1" fill="none" />
      </svg>
    </div>
  );
}
