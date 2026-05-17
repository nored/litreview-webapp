// ner.mjs
//
// Named Entity Recognition via token classification. The candidate
// generator for the named-entity extractors (tech_stack, datasets_used,
// frameworks_cited). Produces ORG / MISC / PER / LOC spans from a
// chunk of text; downstream `entity_resolution.canonicalise()` filters
// them against a curated vocabulary and adds novel entries.
//
// Wraps `@huggingface/transformers`. Default model: `Xenova/bert-base-NER`
// (~110MB, fine-tuned on CoNLL-2003). Lazy-loaded on first use, cache to
// ~/.cache/huggingface/. Same install-path as the embedder / NLI.
//
// Note: bert-base-NER is general-purpose, not scientific-domain-trained.
// It catches well-known names (PyTorch, MIMIC-III, Stanford) reliably but
// misses obscure scientific entities. The entity-resolution layer is the
// safety net: any NER hit must be canonicalisable against the seed vocab
// or pass an embedding-cosine check before it enters the structured
// store. SciBERT-derived variants (`Xenova/scibert_*`) could replace
// bert-base-NER for biomedical corpora; not the default to keep the
// download cost bounded for general use.

import { pipeline, env } from '@huggingface/transformers';

const NER_MODEL_ID = 'Xenova/bert-base-NER';

env.allowRemoteModels = true;
env.allowLocalModels = true;

function pickDtype() {
  const override = (process.env.LITREVIEW_NER_DTYPE || '').toLowerCase().trim();
  if (override) return override;
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'fp16';
  return 'fp32';
}

const DTYPE = pickDtype();

let _nerPromise = null;
// Once model load definitively fails (HF unreachable / rate-limited /
// blocked), don't retry on every per-paper call. Without this, each
// of 968 papers eats a network round trip to HF before falling
// through. That alone can turn a 15-minute corpus extract into a
// multi-hour stall.
let _nerUnavailable = false;
let _nerFailureLogged = false;

export function isUnavailable() { return _nerUnavailable; }

async function _loadOnce(dtype) {
  try {
    return await pipeline('token-classification', NER_MODEL_ID, { dtype });
  } catch (err) {
    if (dtype !== 'fp32') {
      if (!_nerFailureLogged) console.warn(`ner: ${dtype} load failed (${err.message}); falling back to fp32`);
      return _loadOnce('fp32');
    }
    throw err;
  }
}

function _getNer() {
  if (_nerUnavailable) return Promise.reject(new Error('ner model unavailable'));
  if (!_nerPromise) {
    _nerPromise = _loadOnce(DTYPE).catch((err) => {
      _nerUnavailable = true;
      if (!_nerFailureLogged) {
        console.warn(`ner: model unavailable (${err.message}). Skipping NER for the rest of this session; regex + embedding extractors will still run.`);
        _nerFailureLogged = true;
      }
      _nerPromise = null;
      throw err;
    });
  }
  return _nerPromise;
}

/** Pre-warm the NER model. Optional. */
export async function preload() {
  await _getNer();
}

/**
 * Extract named entity spans from a text. Returns an array of
 *   { entity, type, score, start, end, word }
 * where:
 *   entity — the canonical entity type ('ORG', 'MISC', 'PER', 'LOC')
 *   type   — alias for entity, kept for readability in callers
 *   score  — model confidence for this span (0-1)
 *   start  — character offset in `text`
 *   end    — character offset (exclusive)
 *   word   — the verbatim span from `text`
 *
 * BPE merge: Transformers.js's token-classification pipeline can return
 * sub-word tokens with B-/I- prefixes when no aggregation strategy is
 * specified. We use aggregation_strategy: 'simple' to merge sub-words
 * into whole-entity spans, which is what every downstream caller wants.
 *
 * opts:
 *   types     — filter to a subset of entity types, e.g. ['ORG', 'MISC']
 *   minScore  — drop spans below this confidence (default 0)
 */
export async function extract(text, opts = {}) {
  if (!text || typeof text !== 'string' || !text.trim()) return [];
  const ner = await _getNer();
  let raw;
  try {
    raw = await ner(text, { aggregation_strategy: 'simple' });
  } catch (e) {
    // Some Transformers.js versions don't accept aggregation_strategy at
    // call time; fall back without it (downstream callers handle B-/I-
    // less gracefully but won't crash).
    raw = await ner(text);
  }
  // Normalise shape. Aggregated outputs use `entity_group`; un-aggregated
  // use `entity`. Each item: { word, entity_group | entity, score, start,
  // end, index? }.
  const types = opts.types ? new Set(opts.types) : null;
  const minScore = opts.minScore ?? 0;
  const out = [];
  for (const item of raw || []) {
    const ent = item.entity_group ?? item.entity ?? '';
    // B-/I- prefixes appear when no aggregation; strip them for
    // consistency in the output.
    const cleanType = ent.replace(/^[BI]-/, '');
    if (types && !types.has(cleanType)) continue;
    const score = typeof item.score === 'number' ? item.score : 0;
    if (score < minScore) continue;
    out.push({
      entity: cleanType,
      type: cleanType,
      score,
      start: item.start ?? null,
      end: item.end ?? null,
      word: item.word ?? '',
    });
  }
  return out;
}

/**
 * Filter extracted spans down to the named-entity types we use for the
 * structured-data store: ORG (organisations and tooling), MISC (named
 * miscellaneous entities — datasets, frameworks, benchmarks).
 * Convenience wrapper over extract().
 */
export async function extractNamedThings(text, opts = {}) {
  return extract(text, {
    types: ['ORG', 'MISC'],
    minScore: opts.minScore ?? 0.5,
  });
}

export const MODEL = NER_MODEL_ID;
export const DTYPE_IN_USE = DTYPE;
