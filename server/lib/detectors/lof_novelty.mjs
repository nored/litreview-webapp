// detectors/lof_novelty.mjs
//
// Local Outlier Factor (LOF) novelty detection. For each paper, average
// its claim embeddings into a single paper-level vector, then compute
// LOF in the resulting space. Papers with LOF > 1.5 are local outliers
// relative to their nearest neighbours — semantically novel relative
// to the corpus.
//
// LOF (Breunig et al., 2000) is the standard density-based outlier
// measure when "outlier" should be relative to local density rather
// than a global threshold. Better than "distance from centroid" for
// corpora with multiple sub-topics.
//
// Algorithm:
//
//   1. Build per-paper vectors by averaging the paper's claim
//      embeddings (loaded from the JSONL sidecar produced by M3).
//   2. For each paper p, find its k-nearest neighbours kNN(p) by
//      cosine distance (1 − cos_sim).
//   3. reach_dist(p, o) = max(k_distance(o), d(p, o))
//   4. LRD(p) = 1 / mean(reach_dist(p, o) for o in kNN(p))
//   5. LOF(p) = mean(LRD(o) / LRD(p) for o in kNN(p))
//
// k is auto-set to min(20, max(3, ⌊N/4⌋)) for small corpora.

import * as store from '../store.mjs';
import { loadClaimVectors } from '../extractors/claims.mjs';
import { makeMatrix, normalize, dotScore } from '../sbert_utils.mjs';
import { pickThresholds } from './_scale.mjs';

const DEFAULT_MIN_LOF = 1.5;
const MAX_K = 20;
const MIN_K = 3;

function pickK(n) {
  return Math.max(MIN_K, Math.min(MAX_K, Math.floor(n / 4)));
}

// Build per-paper vectors by averaging the paper's claim embeddings.
// Returns { paperIds, matrix } or null if no claim embeddings.
function buildPaperVectors(sidecar) {
  if (!sidecar) return null;
  const { matrix, meta } = sidecar;
  const dim = matrix.dim;
  const byPaper = new Map();   // paper_id → { sumVec: Float64Array, count }
  for (let i = 0; i < meta.length; i++) {
    const pid = meta[i].paper_id;
    if (!byPaper.has(pid)) byPaper.set(pid, { sum: new Float64Array(dim), count: 0 });
    const slot = byPaper.get(pid);
    const offset = i * dim;
    for (let d = 0; d < dim; d++) slot.sum[d] += matrix.data[offset + d];
    slot.count++;
  }
  const paperIds = [...byPaper.keys()];
  if (paperIds.length === 0) return null;
  const out = new Float32Array(paperIds.length * dim);
  for (let i = 0; i < paperIds.length; i++) {
    const slot = byPaper.get(paperIds[i]);
    const off = i * dim;
    const inv = 1 / slot.count;
    for (let d = 0; d < dim; d++) out[off + d] = slot.sum[d] * inv;
  }
  const paperMat = makeMatrix(paperIds.length, dim, out);
  normalize(paperMat);   // unit-length so cosine = dot product
  return { paperIds, matrix: paperMat };
}

export async function detectLofNovelty(opts = {}) {
  await store.init();
  const sidecar = await loadClaimVectors();
  if (!sidecar) {
    return { candidates: [], total_candidates: 0, reason: 'no_claim_embeddings' };
  }
  const built = buildPaperVectors(sidecar);
  if (!built || built.paperIds.length < 4) {
    return { candidates: [], total_candidates: 0, reason: 'too_few_papers_with_embeddings' };
  }
  const { paperIds, matrix } = built;
  const N = paperIds.length;
  const t = pickThresholds();
  const k = opts.k ?? pickK(N);
  const minLof = opts.minLof ?? DEFAULT_MIN_LOF;
  // Cap candidates with corpus-adaptive topK so small corpora don't
  // emit 20 "novelty outliers" out of 30 papers.
  const maxCandidates = opts.maxCandidates ?? Math.min(20, t.topK);

  // Full pairwise cosine — N×N. At thesis scale (≤ few thousand) this
  // is fine; ~10M comparisons at 384-dim is well under a second.
  const sim = dotScore(matrix, matrix);   // length N*N

  // Convert to cosine distance + find k-NN per row.
  const kDist = new Float32Array(N);
  const knn = new Array(N);
  const dist = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) dist[j] = Infinity;
      else dist[j] = 1 - sim[i * N + j];   // cosine distance
    }
    // Pick top-k smallest.
    const idx = Array.from({ length: N }, (_, j) => j);
    idx.sort((a, b) => dist[a] - dist[b]);
    const kIdx = idx.slice(0, k);
    knn[i] = kIdx.map((j) => ({ idx: j, dist: dist[j] }));
    kDist[i] = knn[i][k - 1].dist;
  }

  // Reachability distance + LRD.
  const lrd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sumReach = 0;
    for (const { idx, dist: d } of knn[i]) {
      const reach = Math.max(kDist[idx], d);
      sumReach += reach;
    }
    const avg = sumReach / knn[i].length;
    lrd[i] = avg > 0 ? 1 / avg : 0;
  }

  // LOF score.
  const lof = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sumRatio = 0;
    for (const { idx } of knn[i]) {
      if (lrd[i] > 0) sumRatio += lrd[idx] / lrd[i];
    }
    lof[i] = sumRatio / knn[i].length;
  }

  // Build ranked candidates.
  const ranked = [];
  for (let i = 0; i < N; i++) {
    if (lof[i] >= minLof) ranked.push({ paper_id: paperIds[i], lof: lof[i] });
  }
  ranked.sort((a, b) => b.lof - a.lof);
  const top = ranked.slice(0, maxCandidates);
  if (top.length === 0) {
    return { candidates: [], total_candidates: 0, reason: 'no_papers_above_lof_threshold' };
  }

  // Attach titles.
  const titleRows = store.query(
    `SELECT paper_id, title, year FROM papers WHERE paper_id IN (${top.map(() => '?').join(',')})`,
    top.map((r) => r.paper_id),
  );
  const titles = new Map(titleRows.map((r) => [r.paper_id, r]));

  const candidates = top.map((r) => {
    const info = titles.get(r.paper_id) || {};
    return {
      cell: { paper_id: r.paper_id },
      statistic: {
        lof: Number(r.lof.toFixed(3)),
        k_neighbours: k,
      },
      contributing_papers: [r.paper_id],
      description: `Novel paper (LOF ${r.lof.toFixed(2)}): "${(info.title || r.paper_id).slice(0, 80)}" sits far from its ${k} nearest neighbours in claim space — its language and topics diverge from the corpus locally.`,
      salience: r.lof,
    };
  });

  return {
    candidates,
    total_candidates: ranked.length,
    diagnostics: { n_papers: N, k_used: k, threshold: minLof },
  };
}

export const TYPE = 'lof_novelty';
