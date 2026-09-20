'use client';

import { motion } from 'framer-motion';
import * as React from 'react';
import { cn } from '../lib/cn';
import { fadeUp, staggerContainer } from '../motion';

export interface KineticTextProps {
  words: string[];
  className?: string;
  wordClassName?: string;
}

/** Reveals a phrase word-by-word on mount — headline-grade emphasis. */
export function KineticText({ words, className, wordClassName }: KineticTextProps) {
  return (
    <motion.span initial="hidden" animate="visible" variants={staggerContainer} className={cn('inline', className)}>
      {words.map((word, index) => (
        <motion.span key={`${word}-${index}`} variants={fadeUp} className={cn('inline-block', wordClassName)}>
          {word}
          {index < words.length - 1 ? ' ' : ''}
        </motion.span>
      ))}
    </motion.span>
  );
}
