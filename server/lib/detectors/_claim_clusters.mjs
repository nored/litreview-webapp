// detectors/_claim_clusters.mjs
//
// Shared infrastructure for the cluster-based gap detectors (empirical,
// practical, theoretical). Loads claim embeddings from the JSONL sidecar
// produced by extractors/claims.mjs, runs sbert community_detection over
// the topic embeddings to find natural topic clusters, then materialises
// each cluster with its member claims joined to paper-level fields
// (stance, claim_type, methodology_type, paper category) the detectors
// will consume.
//
// Tunes the clustering thresholds per-corpus via autoTuneCommunityParams,
// since "what counts as the same topic" varies by domain — a tight
// privacy-law corpus clusters differently from a broad ML corpus.
//
// Returns:
//   {
//     clusters: [
//       { id, member_claim_ids, papers, members: [{claim_id, paper_id, ...}, ...] },
//       ...
//     ],
//     unclustered: [...same shape as member...],
//     params: { threshold, minCommunitySize, ... },
//     total_claims: N,
//   }
//
// `clusters` are sorted by size descending. `unclustered` collects
// claims that didn't fall into any community (singletons / outliers).

import * as store from '../store.mjs';
import { loadClaimVectors } from '../extractors/claims.mjs';
import { communityDetection, autoTuneCommunityParams } from '../sbert_utils.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the claim cluster index for the current corpus.
 *
 * opts:
 *   threshold         — cosine cutoff for "same community" (default: auto-tune)
 *   minCommunitySize  — minimum cluster size (default: auto-tune)
 *   maxClusters       — cap on cluster count (default: 50)
 */
export async function buildClusters(opts = {}) {
  await store.init();
  const sidecar = await loadClaimVectors();
  if (!sidecar) {
    return {
      clusters: [], unclustered: [], params: null, total_claims: 0,
      reason: 'no_claim_embeddings — run M3 claim extraction first',
    };
  }
  const { matrix, meta } = sidecar;

  // Auto-tune thresholds unless caller overrode.
  let params;
  if (opts.threshold != null && opts.minCommunitySize != null) {
    params = {
      threshold: opts.threshold,
      minCommunitySize: opts.minCommunitySize,
      k_used: null, n: matrix.rows,
    };
  } else {
    const tuned = autoTuneCommunityParams(matrix, { minSize: 2 });
    params = {
      threshold: opts.threshold ?? tuned.threshold,
      minCommunitySize: opts.minCommunitySize ?? tuned.minCommunitySize,
      k_used: tuned.k_used,
      n: tuned.n,
    };
  }

  const communities = communityDetection(matrix, {
    threshold: params.threshold,
    minCommunitySize: params.minCommunitySize,
  });

  // Pull per-claim metadata from SQLite in one query so we can attach
  // stance, claim_type, paper-level methodology_type, paper-level
  // categories to each cluster member.
  const claimIds = meta.map((m) => m.claim_id);
  const claimRows = claimIds.length > 0
    ? store.query(
        `SELECT c.claim_id, c.paper_id, c.stance, c.claim_type, c.text, c.page,
                mt.field_value AS methodology_type,
                ce.field_value AS challenges_existing
           FROM claims c
           LEFT JOIN paper_field mt ON mt.paper_id = c.paper_id AND mt.field_name = 'methodology_type'
           LEFT JOIN paper_field ce ON ce.paper_id = c.paper_id AND ce.field_name = 'challenges_existing'
          WHERE c.claim_id IN (${claimIds.map(() => '?').join(',')})`,
        claimIds,
      )
    : [];
  const claimMap = new Map(claimRows.map((r) => [r.claim_id, r]));

  // Pull paper-level category memberships for cluster aggregation.
  const paperIds = [...new Set(meta.map((m) => m.paper_id))];
  const catRows = paperIds.length > 0
    ? store.query(
        `SELECT paper_id, category FROM paper_category WHERE paper_id IN (${paperIds.map(() => '?').join(',')})`,
        paperIds,
      )
    : [];
  const catsByPaper = new Map();
  for (const r of catRows) {
    if (!catsByPaper.has(r.paper_id)) catsByPaper.set(r.paper_id, []);
    catsByPaper.get(r.paper_id).push(r.category);
  }

  // Build cluster objects. communityDetection returns arrays of row
  // indices in the matrix order; meta[i] is the parallel metadata.
  const clusters = [];
  const inCluster = new Set();
  let clusterId = 1;
  const maxClusters = opts.maxClusters ?? 50;
  for (const community of communities) {
    if (clusters.length >= maxClusters) break;
    const members = [];
    const paperSet = new Set();
    for (const idx of community) {
      const m = meta[idx];
      if (!m) continue;
      inCluster.add(m.claim_id);
      const row = claimMap.get(m.claim_id) || {};
      members.push({
        claim_id: m.claim_id,
        paper_id: m.paper_id,
        claim_type: row.claim_type ?? m.claim_type,
        stance: row.stance ?? null,
        text: row.text ?? null,
        page: row.page ?? null,
        methodology_type: row.methodology_type ?? null,
        challenges_existing: row.challenges_existing ?? null,
        categories: catsByPaper.get(m.paper_id) || [],
      });
      paperSet.add(m.paper_id);
    }
    clusters.push({
      id: clusterId++,
      size: members.length,
      paper_count: paperSet.size,
      papers: [...paperSet],
      member_claim_ids: members.map((mm) => mm.claim_id),
      members,
    });
  }

  // Unclustered: claims not in any community.
  const unclustered = [];
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i];
    if (inCluster.has(m.claim_id)) continue;
    const row = claimMap.get(m.claim_id) || {};
    unclustered.push({
      claim_id: m.claim_id,
      paper_id: m.paper_id,
      claim_type: row.claim_type ?? m.claim_type,
      stance: row.stance ?? null,
      text: row.text ?? null,
      methodology_type: row.methodology_type ?? null,
      categories: catsByPaper.get(m.paper_id) || [],
    });
  }

  return { clusters, unclustered, params, total_claims: meta.length };
}

/**
 * Build a representative-text summary for a cluster from its members.
 * Picks the longest distinct claim text and adds a count.
 */
export function clusterSummary(cluster) {
  if (!cluster?.members?.length) return '';
  const sample = cluster.members.slice(0, 3).map((m) => m.text).filter(Boolean);
  return `${cluster.size} claims from ${cluster.paper_count} papers. Example: "${(sample[0] || '').slice(0, 140)}…"`;
}
