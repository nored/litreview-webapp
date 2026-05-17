// _scale.mjs
//
// Corpus-size-adaptive thresholds. Most detector heuristics ("≥5 papers
// per framework = orphan", "≥3 papers per category", etc.) are
// reasonable on a 100-paper corpus and wrong on a 30-paper or
// 3000-paper one. Each detector imports `pickThresholds(corpusSize)`
// and uses the returned values instead of hard-coded constants.

import * as store from '../store.mjs';

export function corpusSize() {
  const rows = store.query('SELECT COUNT(*) AS n FROM papers WHERE triage_label IN ("include","maybe")');
  return rows[0]?.n || 0;
}

/**
 * Pure function returning adaptive thresholds for a given corpus size.
 * No caching, no module state — pass `n` explicitly (caller can read
 * once and reuse). Without `n`, queries the store.
 *
 * Returned values:
 *   minPapersPerGroup   — minimum papers required for a group statistic.
 *   orphanRatio         — papers-per-framework "orphan" threshold.
 *   minRowTotal         — (category × method) row marginal threshold.
 *   minClusterSize      — community_detection minSize.
 *   minExternalForGap   — external-comparison gap-cluster threshold.
 *   topK                — default cap on candidates per detector.
 */
export function pickThresholds(n) {
  const N = (typeof n === 'number') ? n : corpusSize();
  // Logistic-style scaling: each threshold has a floor + an N-dependent
  // increase that saturates. Tuned so a 30-paper corpus relaxes
  // thresholds, a 300-paper corpus uses the historical defaults, and a
  // 3000-paper corpus tightens to reduce noise.
  const sqrtN = Math.sqrt(Math.max(1, N));
  return {
    corpus_size: N,
    minPapersPerGroup: Math.max(2, Math.min(8, Math.round(sqrtN / 5))),
    orphanRatio:       Math.max(3, Math.min(15, Math.round(sqrtN / 3))),
    minRowTotal:       Math.max(2, Math.min(10, Math.ceil(N / 30))),
    minClusterSize:    Math.max(2, Math.min(6, Math.round(sqrtN / 6))),
    minExternalForGap: Math.max(2, Math.min(8, Math.round(sqrtN / 4))),
    topK:              N < 50 ? 25 : N < 500 ? 50 : 100,
  };
}

// Kept as a no-op for callers that still invoke it (the cache is gone).
export function clearCache() { /* no cache to clear */ }
