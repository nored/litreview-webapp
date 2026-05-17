// recommend.mjs
//
// Recommendation surface — "given my shortlist, what else should I
// include?". Two signals combine:
//
//   (1) Claim-similarity from the shortlist's frontier. For each
//       claim in the shortlist, find its top-K most-similar claims
//       across the rest of the corpus (via the JSONL claim-embedding
//       sidecar). Papers whose claims surface repeatedly score high.
//
//   (2) Citation pull from inside the shortlist. Papers heavily cited
//       by shortlist members are likely foundational anchors the
//       student missed (or considered but didn't include yet).
//
// Final score = α · normalised_claim_similarity + β · normalised_citation_pull
// (defaults α=0.6, β=0.4 — tuneable).
//
// Returns the top-N non-shortlist papers ranked by combined score, with
// the contributing reasons attached so the UI can show "why".

import * as store from './store.mjs';
import { loadClaimVectors } from './extractors/claims.mjs';
import { makeMatrix, normalize, dotScore } from './sbert_utils.mjs';

const DEFAULT_TOPK = 10;
const DEFAULT_SIM_TOPK_PER_CLAIM = 5;
const DEFAULT_ALPHA = 0.6;
const DEFAULT_BETA  = 0.4;

/**
 * Recommend papers that aren't in the shortlist but are similar /
 * connected to the shortlist.
 *
 * shortlistIds: array of paper_ids the student has already accepted.
 *
 * opts:
 *   topK              — number of recommended papers (default 10)
 *   simTopKPerClaim   — per-shortlist-claim nearest-neighbour cap (default 5)
 *   alpha             — weight on claim-similarity signal (default 0.6)
 *   beta              — weight on citation-pull signal (default 0.4)
 */
export async function recommendCandidates(shortlistIds, opts = {}) {
  await store.init();
  if (!Array.isArray(shortlistIds) || shortlistIds.length === 0) {
    return { recommendations: [], reason: 'empty_shortlist' };
  }
  const topK = opts.topK ?? DEFAULT_TOPK;
  const simTopKPerClaim = opts.simTopKPerClaim ?? DEFAULT_SIM_TOPK_PER_CLAIM;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const beta = opts.beta ?? DEFAULT_BETA;
  const shortlistSet = new Set(shortlistIds);

  // ── (1) Claim-similarity signal ────────────────────────────────────────
  const claimSimScores = new Map();  // paper_id → cumulative sim
  const claimSimContrib = new Map(); // paper_id → list of contributing claim ids
  const sidecar = await loadClaimVectors();
  if (sidecar) {
    const { matrix, meta } = sidecar;
    const dim = matrix.dim;
    // Partition matrix rows into shortlist vs other.
    const shortIdx = [];
    const otherIdx = [];
    for (let i = 0; i < meta.length; i++) {
      if (shortlistSet.has(meta[i].paper_id)) shortIdx.push(i);
      else otherIdx.push(i);
    }
    if (shortIdx.length > 0 && otherIdx.length > 0) {
      // Build separate matrices.
      const shortMat = makeMatrix(shortIdx.length, dim, new Float32Array(shortIdx.length * dim));
      for (let i = 0; i < shortIdx.length; i++) {
        shortMat.data.set(matrix.data.subarray(shortIdx[i] * dim, (shortIdx[i] + 1) * dim), i * dim);
      }
      const otherMat = makeMatrix(otherIdx.length, dim, new Float32Array(otherIdx.length * dim));
      for (let i = 0; i < otherIdx.length; i++) {
        otherMat.data.set(matrix.data.subarray(otherIdx[i] * dim, (otherIdx[i] + 1) * dim), i * dim);
      }
      normalize(shortMat); normalize(otherMat);
      const sim = dotScore(shortMat, otherMat);   // shortMat.rows × otherMat.rows
      // For each shortlist claim, pick its top-K most-similar other claims.
      for (let i = 0; i < shortMat.rows; i++) {
        const scored = [];
        for (let j = 0; j < otherMat.rows; j++) scored.push({ j, s: sim[i * otherMat.rows + j] });
        scored.sort((a, b) => b.s - a.s);
        for (const { j, s } of scored.slice(0, simTopKPerClaim)) {
          if (s <= 0) break;
          const otherMeta = meta[otherIdx[j]];
          const pid = otherMeta.paper_id;
          if (shortlistSet.has(pid)) continue;
          claimSimScores.set(pid, (claimSimScores.get(pid) || 0) + s);
          if (!claimSimContrib.has(pid)) claimSimContrib.set(pid, []);
          claimSimContrib.get(pid).push({ source_claim: meta[shortIdx[i]].claim_id, target_claim: otherMeta.claim_id, sim: Number(s.toFixed(3)) });
        }
      }
    }
  }

  // ── (2) Citation-pull signal ────────────────────────────────────────────
  // For each shortlist paper, count outgoing citations into other papers.
  const citationPull = new Map();   // paper_id → count
  const citationContrib = new Map(); // paper_id → list of shortlist citers
  if (shortlistIds.length > 0) {
    const placeholders = shortlistIds.map(() => '?').join(',');
    const rows = store.query(
      `SELECT from_paper, to_paper FROM citations
        WHERE from_paper IN (${placeholders})`,
      shortlistIds,
    );
    for (const r of rows) {
      if (shortlistSet.has(r.to_paper)) continue;
      citationPull.set(r.to_paper, (citationPull.get(r.to_paper) || 0) + 1);
      if (!citationContrib.has(r.to_paper)) citationContrib.set(r.to_paper, []);
      citationContrib.get(r.to_paper).push(r.from_paper);
    }
  }

  // ── Combine ────────────────────────────────────────────────────────────
  const candidateIds = new Set([...claimSimScores.keys(), ...citationPull.keys()]);
  if (candidateIds.size === 0) {
    return { recommendations: [], reason: 'no_signal' };
  }
  // Restrict to in-corpus papers (we can't recommend something the
  // student hasn't downloaded).
  const idsArr = [...candidateIds];
  const inCorpusRows = store.query(
    `SELECT paper_id, title, year, venue, doi, arxiv_id
       FROM papers
      WHERE paper_id IN (${idsArr.map(() => '?').join(',')})`,
    idsArr,
  );
  const inCorpus = new Map(inCorpusRows.map((r) => [r.paper_id, r]));

  // Min-max normalise each signal so the weights are comparable.
  function minMax(map) {
    let lo = Infinity, hi = -Infinity;
    for (const v of map.values()) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo === hi) return new Map([...map].map(([k]) => [k, 1]));
    const out = new Map();
    for (const [k, v] of map) out.set(k, (v - lo) / (hi - lo));
    return out;
  }
  const simNorm = minMax(claimSimScores);
  const citeNorm = minMax(citationPull);

  const recs = [];
  for (const id of candidateIds) {
    const meta = inCorpus.get(id);
    if (!meta) continue;
    const s1 = simNorm.get(id) || 0;
    const s2 = citeNorm.get(id) || 0;
    const score = alpha * s1 + beta * s2;
    recs.push({
      paper_id: id,
      title: meta.title,
      year: meta.year,
      venue: meta.venue,
      score: Number(score.toFixed(4)),
      signals: {
        claim_similarity: Number(s1.toFixed(4)),
        citation_pull: Number(s2.toFixed(4)),
        raw_claim_sum: Number((claimSimScores.get(id) || 0).toFixed(4)),
        raw_citations_from_shortlist: citationPull.get(id) || 0,
      },
      contributing: {
        claim_matches: (claimSimContrib.get(id) || []).slice(0, 5),
        citing_shortlist_papers: (citationContrib.get(id) || []).slice(0, 5),
      },
    });
  }
  recs.sort((a, b) => b.score - a.score);

  return {
    recommendations: recs.slice(0, topK),
    total_candidates: recs.length,
    weights: { alpha, beta },
  };
}
