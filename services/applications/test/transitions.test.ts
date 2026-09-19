import { describe, expect, it } from 'vitest';
import { allowedNextStatuses, isValidTransition } from '../src/lib/transitions.js';

describe('isValidTransition', () => {
  it('allows the normal happy-path progression', () => {
    expect(isValidTransition('draft', 'queued')).toBe(true);
    expect(isValidTransition('queued', 'submitting')).toBe(true);
    expect(isValidTransition('submitting', 'submitted')).toBe(true);
    expect(isValidTransition('submitted', 'interviewing')).toBe(true);
    expect(isValidTransition('interviewing', 'offer')).toBe(true);
  });

  it('allows withdrawing from any non-terminal state', () => {
    expect(isValidTransition('draft', 'withdrawn')).toBe(true);
    expect(isValidTransition('submitted', 'withdrawn')).toBe(true);
    expect(isValidTransition('offer', 'withdrawn')).toBe(true);
  });

  it('allows requeueing a failed submission', () => {
    expect(isValidTransition('failed', 'queued')).toBe(true);
  });

  it('rejects moving backward out of a later stage', () => {
    expect(isValidTransition('interviewing', 'submitted')).toBe(false);
    expect(isValidTransition('offer', 'draft')).toBe(false);
  });

  it('rejects any transition out of a terminal state', () => {
    expect(allowedNextStatuses('rejected')).toEqual([]);
    expect(allowedNextStatuses('withdrawn')).toEqual([]);
    expect(isValidTransition('rejected', 'offer')).toBe(false);
  });

  it('rejects a no-op transition to the same status', () => {
    expect(isValidTransition('submitted', 'submitted')).toBe(false);
  });
});
