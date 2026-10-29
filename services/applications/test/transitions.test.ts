import { describe, expect, it } from 'vitest';
import {
  allowedNextStatuses,
  isOpenedApplyLinkMarker,
  isValidTransition,
  OPENED_APPLY_LINK_NOTE,
} from '../src/lib/transitions.js';

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
    expect(isValidTransition('draft', 'draft')).toBe(false);
  });

  it('lets a draft be reported as submitted directly (assisted apply on the employer site)', () => {
    expect(isValidTransition('draft', 'submitted')).toBe(true);
  });

  it('does not open any other shortcut past the worker-owned states', () => {
    expect(allowedNextStatuses('draft')).toEqual(['queued', 'submitted', 'withdrawn']);
    expect(isValidTransition('draft', 'submitting')).toBe(false);
    expect(isValidTransition('draft', 'interviewing')).toBe(false);
    expect(isValidTransition('queued', 'submitted')).toBe(false);
    expect(isValidTransition('failed', 'submitted')).toBe(false);
  });
});

describe('isOpenedApplyLinkMarker', () => {
  it('accepts exactly a draft -> draft event noted opened_apply_link', () => {
    expect(OPENED_APPLY_LINK_NOTE).toBe('opened_apply_link');
    expect(isOpenedApplyLinkMarker('draft', 'draft', OPENED_APPLY_LINK_NOTE)).toBe(true);
  });

  it('rejects any other note, or none', () => {
    expect(isOpenedApplyLinkMarker('draft', 'draft', undefined)).toBe(false);
    expect(isOpenedApplyLinkMarker('draft', 'draft', '')).toBe(false);
    expect(isOpenedApplyLinkMarker('draft', 'draft', 'Opened_Apply_Link')).toBe(false);
    expect(isOpenedApplyLinkMarker('draft', 'draft', 'opened_apply_link, then more')).toBe(false);
  });

  it('is only a marker while the application is still a draft', () => {
    expect(isOpenedApplyLinkMarker('queued', 'queued', OPENED_APPLY_LINK_NOTE)).toBe(false);
    expect(isOpenedApplyLinkMarker('submitted', 'submitted', OPENED_APPLY_LINK_NOTE)).toBe(false);
    expect(isOpenedApplyLinkMarker('withdrawn', 'withdrawn', OPENED_APPLY_LINK_NOTE)).toBe(false);
  });

  it('is not a way to change status', () => {
    expect(isOpenedApplyLinkMarker('draft', 'submitted', OPENED_APPLY_LINK_NOTE)).toBe(false);
    expect(isOpenedApplyLinkMarker('draft', 'queued', OPENED_APPLY_LINK_NOTE)).toBe(false);
  });
});
