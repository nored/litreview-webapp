// nli.mjs
//
// Zero-shot text classification via a Natural Language Inference (NLI)
// model. The verifier half of every Stage 1 extractor: regex / NER /
// LLM-finder generates candidates; NLI accepts or rejects each one by
// checking whether a hypothesis ("this sentence claims that the paper
// itself is first in some area") is entailed by the candidate text.
//
// Wraps `@huggingface/transformers` (same install path as the embedder).
// Default model: `Xenova/distilbert-base-uncased-mnli` (~66M params,
// ONNX-converted, MNLI-trained, multi-label
// zero-shot classification trained on MNLI). The pipeline is lazy-loaded
// on first use; model files cache to ~/.cache/huggingface/ on first call.
//
// Two surfaces:
//
//   classify(text, labels, opts)
//       Zero-shot classify `text` into one of `labels`. Returns
//       { label, score, scores } where `scores` is the full distribution.
//       Used for enum-valued fields (methodology_type, system_domain,
//       sample_type) and for multi-label cases via opts.multiLabel.
//
//   verifyEntailment(premise, hypothesis, opts)
//       Single-pair check: does `premise` entail `hypothesis`? Returns
//       { entail, neutral, contradict, label, score }. Used for
//       candidate verification ("does this sentence claim X?") at the
//       end of every regex/NER pipeline. The label is the argmax of
//       {entail, neutral, contradict}.
//
// Threshold convention: NLI score ≥ 0.6 = strong entailment, 0.4-0.6 =
// borderline (record but flag low confidence), < 0.4 = reject. Callers
// decide their own thresholds; this module just returns scores.

import { pipeline, env, AutoTokenizer, AutoModelForSequenceClassification, softmax } from '@huggingface/transformers';

// `Xenova/distilbart-mnli-12-3` doesn't exist on the Xenova mirror, and
// the canonical `valhalla/distilbart-mnli-12-3` lacks tokenizer.json /
// ONNX weights that transformers.js needs. Switched to the closest
// equivalent that IS published in Xenova ONNX form: DistilBERT-base
// fine-tuned on MNLI. ~66M params, similar zero-shot quality, fast.
// Alternative if accuracy matters more: 'Xenova/bart-large-mnli' (~400M).
const ZS_MODEL_ID = 'Xenova/distilbert-base-uncased-mnli';

env.allowRemoteModels = true;
env.allowLocalModels = true;

function pickDtype() {
  const override = (process.env.LITREVIEW_NLI_DTYPE || '').toLowerCase().trim();
  if (override) return override;
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'fp16';
  return 'fp32';
}

const DTYPE = pickDtype();

// Two model loadings for the same checkpoint:
//   _zsPromise — zero-shot-classification pipeline, used by classify() for
//                true zero-shot (scoring text against a free label set).
//   _nliPromise — { tokenizer, model } loaded directly, used by
//                 verifyEntailment*() to call the MNLI head with a real
//                 text-pair (premise + hypothesis). The text-classification
//                 PIPELINE silently ignores text_pair, so we bypass it.
let _zsPromise = null;
let _nliPromise = null;
let _zsUnavailable = false;
let _nliUnavailable = false;
let _failureLogged = false;

export function isUnavailable() { return _zsUnavailable && _nliUnavailable; }

async function _loadPipeline(kind, dtype) {
  try {
    return await pipeline(kind, ZS_MODEL_ID, { dtype });
  } catch (err) {
    if (dtype !== 'fp32') {
      if (!_failureLogged) console.warn(`nli: ${kind} ${dtype} load failed (${err.message}); falling back to fp32`);
      return _loadPipeline(kind, 'fp32');
    }
    throw err;
  }
}

async function _loadNliDirect(dtype) {
  try {
    const tokenizer = await AutoTokenizer.from_pretrained(ZS_MODEL_ID);
    const model = await AutoModelForSequenceClassification.from_pretrained(ZS_MODEL_ID, { dtype });
    // Build a stable id→canonical-label mapping. The model exposes
    // id2label as { '0': 'ENTAILMENT', '1': 'NEUTRAL', '2': 'CONTRADICTION' }
    // (or some permutation). We canonicalise by name so the consumer
    // always reads the right axis regardless of the model's internal
    // class order.
    const id2label = model.config?.id2label || {};
    const axisFor = {};
    for (const [idStr, lab] of Object.entries(id2label)) {
      const lo = String(lab || '').toLowerCase();
      if (lo.includes('entail'))     axisFor[idStr] = 'entail';
      else if (lo.includes('neutral')) axisFor[idStr] = 'neutral';
      else if (lo.includes('contradict')) axisFor[idStr] = 'contradict';
    }
    return { tokenizer, model, axisFor };
  } catch (err) {
    if (dtype !== 'fp32') {
      if (!_failureLogged) console.warn(`nli: direct ${dtype} load failed (${err.message}); falling back to fp32`);
      return _loadNliDirect('fp32');
    }
    throw err;
  }
}

function _getZeroShot() {
  if (_zsUnavailable) return Promise.reject(new Error('nli zero-shot model unavailable'));
  if (!_zsPromise) {
    _zsPromise = _loadPipeline('zero-shot-classification', DTYPE).catch((err) => {
      _zsUnavailable = true;
      if (!_failureLogged) {
        console.warn(`nli: zero-shot unavailable (${err.message}).`);
        _failureLogged = true;
      }
      _zsPromise = null;
      throw err;
    });
  }
  return _zsPromise;
}

function _getNliDirect() {
  if (_nliUnavailable) return Promise.reject(new Error('nli direct model unavailable'));
  if (!_nliPromise) {
    _nliPromise = _loadNliDirect(DTYPE).catch((err) => {
      _nliUnavailable = true;
      if (!_failureLogged) {
        console.warn(`nli: direct unavailable (${err.message}).`);
        _failureLogged = true;
      }
      _nliPromise = null;
      throw err;
    });
  }
  return _nliPromise;
}

/** Pre-warm both. */
export async function preload() {
  await _getZeroShot().catch(() => {});
  await _getNliDirect().catch(() => {});
}

/**
 * Zero-shot classify `text` against `labels`. Returns
 *   { label, score, scores: { [label]: prob, ... }, sequence }
 *
 * opts:
 *   multiLabel   — if true, treat each label independently (entailment
 *                  scores don't sum to 1); useful for "which of these
 *                  apply?" rather than "which one of these". Default false.
 *   hypothesisTemplate — template containing {} where the label gets
 *                  substituted. Default 'This text is about {}.'
 */
export async function classify(text, labels, opts = {}) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { label: null, score: 0, scores: {}, sequence: text || '' };
  }
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error('nli.classify: labels must be a non-empty array');
  }
  const classifier = await _getZeroShot();
  const result = await classifier(text, labels, {
    multi_label: !!opts.multiLabel,
    hypothesis_template: opts.hypothesisTemplate || 'This text is about {}.',
  });
  // Transformers.js shape: { sequence, labels: [...], scores: [...] }
  const labelsArr = Array.isArray(result?.labels) ? result.labels : [];
  const scoresArr = Array.isArray(result?.scores) ? result.scores : [];
  const scores = {};
  for (let i = 0; i < labelsArr.length; i++) scores[labelsArr[i]] = scoresArr[i];
  return {
    label: labelsArr[0] ?? null,
    score: scoresArr[0] ?? 0,
    scores,
    sequence: result?.sequence ?? text,
  };
}

function pickLabel(entail, neutral, contradict) {
  const max = Math.max(entail, neutral, contradict);
  return {
    label: max === entail ? 'entailment' : max === neutral ? 'neutral' : 'contradiction',
    score: max,
  };
}

/**
 * Single-pair entailment check. Tokenises (premise, hypothesis) as a text
 * pair, runs the MNLI head directly, softmaxes the logits, returns
 *   { entail, neutral, contradict, label, score, premise, hypothesis }.
 *
 * The transformers.js text-classification PIPELINE silently ignores the
 * text_pair argument — confirmed by reproduction — so we call the
 * tokenizer + model ourselves to get a real NLI verdict.
 */
export async function verifyEntailment(premise, hypothesis, _opts = {}) {
  if (!premise || !hypothesis) {
    return { entail: 0, neutral: 0, contradict: 0, label: 'neutral', score: 0, premise: premise || '', hypothesis: hypothesis || '' };
  }
  const { tokenizer, model, axisFor } = await _getNliDirect();
  const inputs = await tokenizer(String(premise), {
    text_pair: String(hypothesis),
    return_tensors: 'js',
    padding: true,
    truncation: true,
  });
  const { logits } = await model(inputs);
  const probs = softmax(logits.data);
  let entail = 0, neutral = 0, contradict = 0;
  for (let i = 0; i < probs.length; i++) {
    const axis = axisFor[String(i)];
    if (axis === 'entail') entail = probs[i];
    else if (axis === 'neutral') neutral = probs[i];
    else if (axis === 'contradict') contradict = probs[i];
  }
  const { label, score } = pickLabel(entail, neutral, contradict);
  return { entail, neutral, contradict, label, score, premise, hypothesis };
}

/**
 * Batched entailment: parallel premises all against the SAME hypothesis.
 * Returns one verdict per premise in input order.
 *
 * Note: transformers.js text-classification with text_pair as an array
 * silently fails — it ignores the per-row pairing and the pipeline
 * returns the same shape regardless of premise. We call per-item; ONNX
 * keeps the model loaded so the per-call cost is just one forward pass
 * (~100-200ms each on Apple Silicon fp16).
 */
export async function verifyEntailmentBatch(premises, hypothesis, _opts = {}) {
  if (!Array.isArray(premises) || premises.length === 0) return [];
  const out = [];
  for (const p of premises) {
    out.push(await verifyEntailment(p, hypothesis));
  }
  return out;
}

/**
 * Batched zero-shot classification: classify a list of texts against the
 * SAME label set. Returns an array of { label, score, scores, sequence }
 * in input order.
 */
export async function classifyBatch(texts, labels, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (texts.length === 1) return [await classify(texts[0], labels, opts)];
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error('classifyBatch: labels must be a non-empty array');
  }
  const classifier = await _getZeroShot();
  const results = await classifier(texts, labels, {
    multi_label: !!opts.multiLabel,
    hypothesis_template: opts.hypothesisTemplate || 'This text is about {}.',
  });
  const arr = Array.isArray(results) ? results : [results];
  return arr.map((r) => {
    const labelsArr = Array.isArray(r?.labels) ? r.labels : [];
    const scoresArr = Array.isArray(r?.scores) ? r.scores : [];
    const scores = {};
    for (let i = 0; i < labelsArr.length; i++) scores[labelsArr[i]] = scoresArr[i];
    return {
      label: labelsArr[0] ?? null,
      score: scoresArr[0] ?? 0,
      scores,
      sequence: r?.sequence ?? '',
    };
  });
}

export const MODEL = ZS_MODEL_ID;
export const DTYPE_IN_USE = DTYPE;
