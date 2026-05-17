// detectors/empirical_gap.mjs
//
// Type 5: Empirical gap. A topic cluster has theoretical / hypothesised
// claims but no empirically validated ones. Someone has theorised X,
// nobody has tested it.
//
// Algorithm:
//
//   1. Build claim clusters via _claim_clusters.buildClusters().
//   2. For each cluster, count claims by stance:
//        * theorises_count  — claims.stance == 'theorises'
//        * validates_count  — claims.stance == 'validates'
//        * other_count      — everything else
//   3. Flag clusters with `theorises_count >= minTheorises` AND
//      `validates_count == 0` (or below a tiny floor that allows for
//      stance-classifier mis-labels).
//   4. Salience = theorises_count * paper_count (larger groups of
//      papers waiting on validation matter more).

import * as store from '../store.mjs';
import { buildClusters, clusterSummary } from './_claim_clusters.mjs';
import { pickThresholds } from './_scale.mjs';

const DEFAULT_MAX_VALIDATES = 0;
const DEFAULT_MAX_CANDIDATES = 25;

export async function detectEmpiricalGap(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const minTheorises = opts.minTheorises ?? Math.max(2, t.minClusterSize);
  const maxValidates = opts.maxValidates ?? DEFAULT_MAX_VALIDATES;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const clusterIndex = opts.clusters ?? await buildClusters(opts);
  if (!clusterIndex.clusters || clusterIndex.clusters.length === 0) {
    return {
      candidates: [], total_candidates: 0,
      reason: clusterIndex.reason || 'no_claim_clusters',
    };
  }

  const candidates = [];
  for (const cluster of clusterIndex.clusters) {
    let theorises = 0, validates = 0, other = 0;
    const theorisingPapers = new Set();
    const exampleQuotes = [];
    for (const m of cluster.members) {
      const stance = String(m.stance || '').toLowerCase();
      if (stance === 'theorises') {
        theorises++;
        theorisingPapers.add(m.paper_id);
        if (exampleQuotes.length < 3 && m.text) exampleQuotes.push({ paper_id: m.paper_id, text: m.text, page: m.page });
      } else if (stance === 'validates') {
        validates++;
      } else {
        other++;
      }
    }
    if (theorises < minTheorises) continue;
    if (validates > maxValidates) continue;

    candidates.push({
      cell: { cluster_id: cluster.id },
      statistic: {
        theorises, validates, other,
        cluster_size: cluster.size,
        paper_count: cluster.paper_count,
      },
      contributing_papers: [...theorisingPapers],
      example_quotes: exampleQuotes,
      description: `${theorises} claim(s) across ${theorisingPapers.size} paper(s) theorise something in this topic, but no paper empirically validates it. ${clusterSummary(cluster)}`,
      salience: theorises * cluster.paper_count,
    });
  }

  candidates.sort((a, b) => b.salience - a.salience);
  return {
    candidates: candidates.slice(0, maxCandidates),
    total_candidates: candidates.length,
    clustering_params: clusterIndex.params,
  };
}

export const TYPE = 'empirical';
