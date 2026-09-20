import { describe, expect, it } from 'vitest';
import { computeLearningMetrics, type ScoredJobRow } from '../src/lib/metrics.js';

describe('computeLearningMetrics', () => {
  it('reports positive lift when applied jobs scored higher than skipped ones', () => {
    const scores: ScoredJobRow[] = [
      { modelVersion: 'heuristic-v1', score: 0.9, userId: 'u1', jobId: 'applied-1' },
      { modelVersion: 'heuristic-v1', score: 0.8, userId: 'u1', jobId: 'applied-2' },
      { modelVersion: 'heuristic-v1', score: 0.2, userId: 'u1', jobId: 'skipped-1' },
      { modelVersion: 'heuristic-v1', score: 0.3, userId: 'u1', jobId: 'skipped-2' },
    ];
    const applied = new Set(['u1:applied-1', 'u1:applied-2']);

    const [metric] = computeLearningMetrics(scores, applied);
    expect(metric).toBeDefined();
    expect(metric!.appliedSamples).toBe(2);
    expect(metric!.notAppliedSamples).toBe(2);
    expect(metric!.appliedMeanScore).toBeCloseTo(0.85);
    expect(metric!.notAppliedMeanScore).toBeCloseTo(0.25);
    expect(metric!.lift).toBeCloseTo(0.6);
  });

  it('returns null lift when every scored job in a model version was applied to', () => {
    const scores: ScoredJobRow[] = [{ modelVersion: 'heuristic-v1', score: 0.7, userId: 'u1', jobId: 'j1' }];
    const applied = new Set(['u1:j1']);

    const [metric] = computeLearningMetrics(scores, applied);
    expect(metric!.notAppliedSamples).toBe(0);
    expect(metric!.notAppliedMeanScore).toBeNull();
    expect(metric!.lift).toBeNull();
  });

  it('keeps separate model versions separate', () => {
    const scores: ScoredJobRow[] = [
      { modelVersion: 'heuristic-v1', score: 0.9, userId: 'u1', jobId: 'j1' },
      { modelVersion: 'heuristic-v2', score: 0.5, userId: 'u1', jobId: 'j2' },
    ];
    const metrics = computeLearningMetrics(scores, new Set());
    expect(metrics.map((m) => m.modelVersion).sort()).toEqual(['heuristic-v1', 'heuristic-v2']);
  });

  it('returns an empty array for no scores', () => {
    expect(computeLearningMetrics([], new Set())).toEqual([]);
  });
});
