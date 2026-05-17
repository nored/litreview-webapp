// reranker.mjs
//
// Cross-encoder reranking for the precision pass at the end of hybrid
// retrieval. Wraps a small MS MARCO-trained cross-encoder via
// `@huggingface/transformers` (same install path as the embedder; no
// native bindings, no Chromium).
//
// Why cross-encoder: bi-encoder (the embedder we already use) computes
// independent embeddings of query and document, then compares with cosine.
// Fast — entire corpus retrieval in milliseconds — but loses precision
// because the model never sees query and doc together. A cross-encoder
// takes (query, doc) as a *pair*, lets attention cross-pollinate, and
// scores the pair directly. Slower (one forward pass per pair, can't
// batch the corpus), so we only run it on the top-N candidates from the
// fast hybrid retrieval.
//
// Benchmarks: cross-encoder rerank on top of bi-encoder retrieval is
// the single biggest precision win in modern IR; MRR@3 commonly jumps
// from ~0.43 to ~0.60 on standard test sets.
//
// Lifecycle mirrors embedder.mjs: lazy load on first use, model files
// cache to ~/.cache/huggingface/ on first call, subsequent process
// boots reuse the cache.

import { pipeline, env } from '@huggingface/transformers';

// Default model: small (~80MB), trained on MS MARCO, returns a single
// logit per (query, doc) pair where higher = more relevant. The L-12-v2
// variant is more accurate but doubles the latency; L-6-v2 is the
// sweet spot at thesis scale.
const MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';

env.allowRemoteModels = true;
env.allowLocalModels = true;

function pickDtype() {
  const override = (process.env.LITREVIEW_RERANK_DTYPE || '').toLowerCase().trim();
  if (override) return override;
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'fp16';
  return 'fp32';
}

const DTYPE = pickDtype();

let _pipelinePromise = null;

function _getPipeline() {
  if (!_pipelinePromise) {
    _pipelinePromise = pipeline('text-classification', MODEL_ID, { dtype: DTYPE })
      .catch(async (err) => {
        if (DTYPE !== 'fp32') {
          console.warn(`reranker: ${DTYPE} load failed (${err.message}); falling back to fp32`);
          _pipelinePromise = pipeline('text-classification', MODEL_ID, { dtype: 'fp32' })
            .catch((e2) => { _pipelinePromise = null; throw e2; });
          return _pipelinePromise;
        }
        _pipelinePromise = null;
        throw err;
      });
  }
  return _pipelinePromise;
}

/** Pre-warm the model. Optional. */
export async function preload() {
  await _getPipeline();
}

/**
 * Rerank a small batch of (query, document) candidates and return them
 * sorted by relevance descending.
 *
 * query: string
 * candidates: [{ doc_id, text }, ...]
 * opts:
 *   topK     — return at most this many (default: all candidates)
 *
 * Returns: [{ doc_id, score }, ...] sorted by score desc.
 *
 * Cost: O(candidates) forward passes. ~30-60ms per pair on a current
 * laptop CPU at fp16. Keep candidate count ≤ 50 for interactive use.
 */
export async function rerank(query, candidates, opts = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('reranker.rerank: query must be a non-empty string');
  }
  const pipe = await _getPipeline();
  const topK = opts.topK ?? candidates.length;

  // Transformers.js's text-classification pipeline accepts a SequenceClassifierInput.
  // For cross-encoders trained as sentence-pair classifiers, the model takes
  // (text, text_pair). We call sequentially per pair — batching across pairs
  // adds padding overhead and isn't necessarily faster at modest batch sizes.
  const scored = [];
  for (const c of candidates) {
    if (!c.text) {
      scored.push({ doc_id: c.doc_id, score: -Infinity });
      continue;
    }
    let result;
    try {
      result = await pipe({ text: query, text_pair: c.text });
    } catch (e) {
      // Some Transformers.js versions expect positional args; try fallback.
      try {
        result = await pipe(query, c.text);
      } catch (e2) {
        console.warn('reranker: rerank failed for doc', c.doc_id, e2?.message || e2);
        scored.push({ doc_id: c.doc_id, score: -Infinity });
        continue;
      }
    }
    // Result shape per Transformers.js: { label, score } OR [{ label, score }].
    // MS MARCO cross-encoder is single-label; score is the relevance logit
    // mapped through sigmoid by the pipeline.
    const raw = Array.isArray(result) ? result[0] : result;
    const s = typeof raw?.score === 'number' ? raw.score : -Infinity;
    scored.push({ doc_id: c.doc_id, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** Constants surfaced so callers (status pills, tests) can show what's in use. */
export const MODEL = MODEL_ID;
export const DTYPE_IN_USE = DTYPE;
