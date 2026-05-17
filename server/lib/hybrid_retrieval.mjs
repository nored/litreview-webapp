// hybrid_retrieval.mjs
//
// Hybrid retrieval = BM25 (sparse) + dense embedding (cosine) combined
// via Reciprocal Rank Fusion. Optional cross-encoder rerank on the top-N
// before returning final top-K.
//
// Why hybrid: BM25 is unbeatable at exact technical-term matches (dataset
// names, framework names, metric names, acronyms) — the things semantic
// embeddings can blur. Dense retrieval catches paraphrase and synonymy
// that BM25 misses ("graph neural network" ↔ "GNN" ↔ "message passing").
// Used in combination they trade off cleanly, and RRF combines their
// rankings without any score normalisation (the two scoring spaces are
// incompatible, so working in rank space dodges the problem entirely).
//
// Reciprocal Rank Fusion (Cormack et al., 2009):
//
//   rrf_score(d) = Σ_R  1 / (k + rank_R(d))
//
// where R ranges over each ranking system (BM25, dense), rank_R(d) is
// the 1-based position of doc d in ranking R, and k is a smoothing
// constant (60 is the conventional default — high enough that small
// rank differences don't dominate, low enough that the top of the
// ranking still wins decisively).
//
// Cross-encoder rerank: after RRF picks top-N candidates, optionally
// run them through a sequence-pair classifier (e.g. ms-marco-MiniLM)
// for a final precision pass. Bounded to top-N because cross-encoder
// inference is per-pair: too expensive for the whole corpus, perfect
// for ~50 candidates.

import * as sbert from './sbert_utils.mjs';

const DEFAULT_RRF_K = 60;
const DEFAULT_FUSION_TOPK = 50;
const DEFAULT_FINAL_TOPK = 10;

/**
 * Run hybrid retrieval. Returns ranked hits as
 *   [{ doc_id, score, sources: { bm25_rank, dense_rank, rerank_score } }, ...]
 * Sources tells you why a given hit surfaced, useful for provenance.
 *
 * params (all named, all optional unless noted):
 *   queryText         — string. Required if bm25Index is given.
 *   queryVector       — Float32Array (or array). Required if denseCorpus is given.
 *   bm25Index         — BM25Index from bm25.mjs
 *   denseCorpus       — { data: Float32Array, rows, dim } per sbert_utils matrix shape
 *   denseIds          — string[] paralleling denseCorpus rows (so we can map row→doc_id)
 *   fusionTopK        — how many candidates each system contributes pre-fusion (default 50)
 *   finalTopK         — how many to return after fusion (default 10)
 *   rrfK              — RRF constant (default 60)
 *   reranker          — optional async (query, [{doc_id, text}, ...]) → [{doc_id, score}]
 *                       If given, reranks the post-fusion top-finalTopK and reorders.
 *   docTextById       — optional Map or function (doc_id → text). Required if reranker is given.
 */
export async function hybridSearch(params = {}) {
  const {
    queryText,
    queryVector,
    bm25Index,
    denseCorpus,
    denseIds,
    fusionTopK = DEFAULT_FUSION_TOPK,
    finalTopK = DEFAULT_FINAL_TOPK,
    rrfK = DEFAULT_RRF_K,
    reranker,
    docTextById,
  } = params;

  if (!bm25Index && !denseCorpus) {
    throw new Error('hybridSearch: at least one of bm25Index / denseCorpus required');
  }

  // 1. Sparse ranking via BM25
  const bm25Rank = new Map();
  if (bm25Index && queryText) {
    const hits = bm25Index.search(queryText, { topK: fusionTopK });
    for (let i = 0; i < hits.length; i++) {
      bm25Rank.set(hits[i].doc_id, i + 1);  // 1-based rank
    }
  }

  // 2. Dense ranking via cosine over the corpus matrix.
  const denseRank = new Map();
  if (denseCorpus && queryVector) {
    if (!denseIds || denseIds.length !== denseCorpus.rows) {
      throw new Error('hybridSearch: denseIds must parallel denseCorpus.rows');
    }
    const qMat = sbert.makeMatrix(1, denseCorpus.dim, Float32Array.from(queryVector));
    const hits = sbert.semanticSearch(qMat, denseCorpus, {
      topK: fusionTopK,
      scoreFn: 'cos_sim',
    });
    for (let i = 0; i < hits[0].length; i++) {
      const corpusId = hits[0][i].corpus_id;
      denseRank.set(denseIds[corpusId], i + 1);
    }
  }

  // 3. Reciprocal Rank Fusion
  const allIds = new Set([...bm25Rank.keys(), ...denseRank.keys()]);
  const fused = [];
  for (const docId of allIds) {
    let score = 0;
    const sources = {};
    if (bm25Rank.has(docId)) {
      const r = bm25Rank.get(docId);
      score += 1 / (rrfK + r);
      sources.bm25_rank = r;
    }
    if (denseRank.has(docId)) {
      const r = denseRank.get(docId);
      score += 1 / (rrfK + r);
      sources.dense_rank = r;
    }
    fused.push({ doc_id: docId, score, sources });
  }
  fused.sort((a, b) => b.score - a.score);

  // 4. Take post-fusion top-finalTopK candidates.
  const candidates = fused.slice(0, finalTopK);

  // 5. Optional cross-encoder rerank.
  if (reranker && candidates.length > 0) {
    if (!docTextById) {
      throw new Error('hybridSearch: docTextById required when reranker is given');
    }
    const get = typeof docTextById === 'function'
      ? (id) => docTextById(id)
      : (id) => docTextById.get(id);
    const pairs = candidates.map((c) => ({
      doc_id: c.doc_id,
      text: get(c.doc_id) || '',
    })).filter((p) => p.text);
    const reranked = await reranker(queryText, pairs);
    // reranker returns [{ doc_id, score }, ...] reordered by precision.
    const reorderedMap = new Map();
    for (let i = 0; i < reranked.length; i++) reorderedMap.set(reranked[i].doc_id, reranked[i].score);
    // Attach rerank score, sort by rerank_score desc.
    const final = candidates.map((c) => ({
      ...c,
      sources: { ...c.sources, rerank_score: reorderedMap.get(c.doc_id) ?? null },
    }));
    final.sort((a, b) => {
      const ra = a.sources.rerank_score ?? -Infinity;
      const rb = b.sources.rerank_score ?? -Infinity;
      return rb - ra;
    });
    return final;
  }

  return candidates;
}

/**
 * Convenience standalone RRF over arbitrary rankings. Each ranking is
 * an array of doc_id strings (the order IS the rank — 1-based). Returns
 * fused [{doc_id, score, sources: { ranking_index: rank, ... }}, ...].
 */
export function reciprocalRankFusion(rankings, opts = {}) {
  const k = opts.k ?? DEFAULT_RRF_K;
  const ids = new Map();
  for (let i = 0; i < rankings.length; i++) {
    const ranking = rankings[i];
    for (let r = 0; r < ranking.length; r++) {
      const docId = ranking[r];
      let entry = ids.get(docId);
      if (!entry) { entry = { score: 0, sources: {} }; ids.set(docId, entry); }
      entry.score += 1 / (k + (r + 1));
      entry.sources[i] = r + 1;
    }
  }
  const out = [];
  for (const [docId, { score, sources }] of ids) out.push({ doc_id: docId, score, sources });
  out.sort((a, b) => b.score - a.score);
  return out;
}
