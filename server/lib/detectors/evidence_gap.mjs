// detectors/evidence_gap.mjs
//
// Type 1: Evidence gap. Multiple papers report results on the same
// (metric, dataset) tuple — but their reported values disagree more
// than usual. The disagreement itself is a research gap: either one of
// the papers is wrong, the experimental setups silently differ, or the
// metric is sensitive to a factor the literature hasn't called out.
//
// Pure SQL aggregation over the `results` table. We require:
//   * ≥3 papers reporting the same (metric, dataset) (or just metric
//     when dataset is null) — small numbers are noisy.
//   * A non-trivial spread: max − min ≥ a threshold scaled to the
//     metric's natural range. Most metrics are in [0,1] (F1, AUROC,
//     accuracy, IoU, …); regression metrics (MAE, RMSE, MSE) can be
//     much larger. We use coefficient of variation (stddev / mean) for
//     scale-invariance.
//
// No LLM, no claim clustering. Just SQL + a tiny variance computation.

import * as store from '../store.mjs';
import { pickThresholds } from './_scale.mjs';

// Defaults
const DEFAULT_MIN_RANGE = 0.10;    // for metrics roughly in [0,1]; CV threshold below catches scale-invariant cases
const DEFAULT_MIN_CV = 0.15;        // coefficient of variation
const DEFAULT_MAX_CANDIDATES = 50;

export async function detectEvidenceGap(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const minPapers = opts.minPapers ?? Math.max(2, t.minPapersPerGroup);
  const minRange = opts.minRange ?? DEFAULT_MIN_RANGE;
  const minCV = opts.minCV ?? DEFAULT_MIN_CV;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  // Aggregate over (metric, dataset). We treat NULL dataset as a
  // separate group ("metric_alone"). This keeps F1-without-dataset
  // out of comparisons across different actual datasets.
  const rows = store.query(`
    SELECT metric,
           COALESCE(dataset, '__no_dataset__') AS dataset_key,
           dataset,
           COUNT(DISTINCT paper_id) AS n_papers,
           MIN(value) AS lo,
           MAX(value) AS hi,
           AVG(value) AS mean,
           group_concat(DISTINCT paper_id) AS paper_ids
      FROM results
     WHERE value IS NOT NULL
     GROUP BY metric, dataset_key
  `);

  // Compute per-group stddev in JS (SQLite has no STDDEV built-in).
  const candidates = [];
  for (const r of rows) {
    if (r.n_papers < minPapers) continue;
    if (r.hi == null || r.lo == null) continue;
    const range = r.hi - r.lo;
    // Pull the individual values for stddev.
    const vRows = store.query(
      `SELECT paper_id, value FROM results WHERE metric = ? AND ${
        r.dataset_key === '__no_dataset__' ? 'dataset IS NULL' : 'dataset = ?'
      }`,
      r.dataset_key === '__no_dataset__' ? [r.metric] : [r.metric, r.dataset_key],
    );
    if (vRows.length < minPapers) continue;
    const values = vRows.map((v) => v.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);
    const cv = mean !== 0 ? stddev / Math.abs(mean) : 0;
    // Pass either an absolute range threshold (for [0,1]-bounded metrics)
    // OR a coefficient-of-variation threshold (scale-invariant).
    if (range < minRange && cv < minCV) continue;

    candidates.push({
      cell: {
        metric: r.metric,
        dataset: r.dataset,
      },
      statistic: {
        n_papers: r.n_papers,
        min: r.lo,
        max: r.hi,
        range,
        mean: Number(mean.toFixed(6)),
        stddev: Number(stddev.toFixed(6)),
        cv: Number(cv.toFixed(4)),
      },
      contributing_papers: vRows.map((v) => ({ paper_id: v.paper_id, value: v.value })),
      description: r.dataset
        ? `On dataset "${r.dataset}", ${r.n_papers} papers report ${r.metric} values spanning ${r.lo.toFixed(3)} to ${r.hi.toFixed(3)} (cv = ${cv.toFixed(2)}). Investigate the disagreement.`
        : `${r.n_papers} papers report ${r.metric} (no dataset attached) spanning ${r.lo.toFixed(3)} to ${r.hi.toFixed(3)} (cv = ${cv.toFixed(2)}).`,
      salience: range * Math.log(1 + r.n_papers),
    });
  }
  candidates.sort((a, b) => b.salience - a.salience);
  return {
    candidates: candidates.slice(0, maxCandidates),
    total_candidates: candidates.length,
  };
}

export const TYPE = 'evidence';
