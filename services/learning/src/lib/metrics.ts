export interface ScoredJobRow {
  modelVersion: string;
  score: number;
  userId: string;
  jobId: string;
}

export interface ModelMetric {
  modelVersion: string;
  appliedMeanScore: number | null;
  notAppliedMeanScore: number | null;
  appliedSamples: number;
  notAppliedSamples: number;
  /** appliedMeanScore - notAppliedMeanScore. Positive means the model's higher
   * scores are actually correlated with users applying — the thing a scoring
   * model is *for*. Null until there's at least one sample on both sides. */
  lift: number | null;
}

/** Running totals for one model version, before they are turned into means. */
export interface ModelGroup {
  modelVersion: string;
  appliedSum: number;
  appliedCount: number;
  notAppliedSum: number;
  notAppliedCount: number;
}

/**
 * Turns per-model totals into the metric. The one place "mean" and "lift" are
 * defined, shared by the in-memory path below and the aggregate query in
 * `repo/lookups.ts`, so the two cannot drift apart.
 */
export function summarizeGroups(groups: ModelGroup[]): ModelMetric[] {
  return groups.map((group) => {
    const appliedMeanScore = group.appliedCount > 0 ? group.appliedSum / group.appliedCount : null;
    const notAppliedMeanScore = group.notAppliedCount > 0 ? group.notAppliedSum / group.notAppliedCount : null;
    return {
      modelVersion: group.modelVersion,
      appliedMeanScore,
      notAppliedMeanScore,
      appliedSamples: group.appliedCount,
      notAppliedSamples: group.notAppliedCount,
      lift: appliedMeanScore !== null && notAppliedMeanScore !== null ? appliedMeanScore - notAppliedMeanScore : null,
    };
  });
}

/**
 * The honest version of a "learning loop" available without any ML
 * infrastructure or a labeled outcome dataset (no LLM/model API key is
 * configured anywhere in this repo, same constraint `@atlas/ai` documents):
 * measure whether matching-service's scores actually predict who applies,
 * rather than pretending to retrain weights against data that doesn't exist.
 */
export function computeLearningMetrics(scores: ScoredJobRow[], appliedPairs: Set<string>): ModelMetric[] {
  const groups = new Map<string, ModelGroup>();

  for (const row of scores) {
    const group = groups.get(row.modelVersion) ?? {
      modelVersion: row.modelVersion,
      appliedSum: 0,
      appliedCount: 0,
      notAppliedSum: 0,
      notAppliedCount: 0,
    };
    if (appliedPairs.has(`${row.userId}:${row.jobId}`)) {
      group.appliedSum += row.score;
      group.appliedCount += 1;
    } else {
      group.notAppliedSum += row.score;
      group.notAppliedCount += 1;
    }
    groups.set(row.modelVersion, group);
  }

  return summarizeGroups([...groups.values()]);
}
