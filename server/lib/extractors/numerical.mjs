// extractors/numerical.mjs
//
// Numerical fields:
//
//   sample_size  — the largest plausible study-N reported in the paper's
//                  methods / setup sections. One scalar per paper, stored
//                  in `paper_field` as field_type='number'.
//
//   results[]    — every (metric, value, dataset?, split?) triple found
//                  in the results / discussion sections. Each emits one
//                  `results` row.
//
// Both rely on regex for candidate generation (numbers near keywords),
// then NLI verification that the value is the *paper's own* finding
// — not a number cited from prior work. The verification step is what
// distinguishes "F1 = 0.84" reported by THIS paper from "BERT achieved
// F1 = 0.91" in the related-work section describing someone else.
//
// Metric resolution: matches go through the metrics EntityResolver
// (data/_vocab/metrics.json) so "F1", "f1 score", "macro-F1" all map
// to a canonical metric id.
//
// Dataset attachment: within the same sentence as the number, we look
// for any canonical dataset name (already populated for this paper in
// `name_usage` by named_entities.mjs). If found, attach it; otherwise
// the result row is dataset-less (still useful, but less informative
// for the Evidence-gap detector).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as store from '../store.mjs';
import * as nli from '../nli.mjs';
import { EntityResolver, normalize } from '../entity_resolution.mjs';
import { eligibleChunksWithFallback, annotateMechanism } from './_section_routing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOCAB_DIR = path.join(__dirname, '..', '..', '..', 'data', '_vocab');

// ─────────────────────────────────────────────────────────────────────────
// Sample-size patterns
// ─────────────────────────────────────────────────────────────────────────
//
// Each pattern captures a number we MIGHT treat as the study N. False
// positives (page counts, model parameters, etc.) get filtered by the
// sample-size sanity range + NLI verification.

const SAMPLE_SIZE_PATTERNS = [
  /\bn\s*=\s*([\d,]+)/i,
  /\bN\s*=\s*([\d,]+)/,
  /\bsample\s+size\s+of\s+([\d,]+)/i,
  /\b([\d,]+)\s+(?:patients?|participants?|subjects?|individuals?|cases?|examples?|samples?|images?|instances?|records?|documents?|sentences?|tweets?|users?|sessions?|trials?|observations?)\b/i,
];

// Drop unreasonably tiny / huge values. Below 5 = anecdote; above 1e9 =
// likely a model-parameter count or a year, not a sample.
const SAMPLE_SIZE_MIN = 5;
const SAMPLE_SIZE_MAX = 1_000_000_000;
const SAMPLE_SIZE_HYPOTHESIS =
  "This sentence states the size of the paper's own study population, dataset, or sample.";
const SAMPLE_SIZE_THRESHOLD = 0.45;
const SAMPLE_SIZE_SECTIONS = ['abstract', 'methods', 'experimental_setup', 'results'];

// ─────────────────────────────────────────────────────────────────────────
// Results patterns
// ─────────────────────────────────────────────────────────────────────────
//
// Regex looks for any number near a metric keyword. We then re-validate
// against the canonical metric vocabulary so noise like "Figure 0.84"
// or "equation (3.5)" gets dropped.

// Generic number: optionally signed, decimal, optionally percent.
const NUMBER_RE = String.raw`(\d+(?:\.\d+)?)\s*%?`;

// We construct the result-search regex dynamically from the loaded metrics
// vocabulary; pre-compile a "loose" version here as a fallback.
const RESULTS_SECTIONS = ['results', 'discussion', 'abstract'];
const RESULTS_HYPOTHESIS =
  "This sentence reports a result obtained by this paper's own experiments, not a result cited from prior work.";
const RESULTS_THRESHOLD = 0.45;
// Plausible metric-value range. Things like F1, AUROC, accuracy are [0,1]
// or [0,100]; MAE/MSE can be larger. We accept anything up to 1000;
// the NLI step does the real filtering.
const VALUE_MIN = 0;
const VALUE_MAX = 1000;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

let _metricsResolver = null;
async function getMetricsResolver() {
  if (_metricsResolver) return _metricsResolver;
  _metricsResolver = new EntityResolver({ kind: 'metric' });
  try {
    const blob = JSON.parse(await fs.readFile(path.join(VOCAB_DIR, 'metrics.json'), 'utf8'));
    _metricsResolver.loadFromObject(blob);
  } catch (e) {
    console.warn(`numerical: failed to load metrics vocab: ${e.message}`);
  }
  return _metricsResolver;
}

function eligibleChunks(paperId, sectionLabels) {
  const { rows, tier } = eligibleChunksWithFallback(paperId, sectionLabels);
  // Stamp tier on each row so the caller can annotate provenance.
  for (const r of rows) r._tier = tier;
  return rows;
}

// Reuse the (simple) sentence splitter shape from bool_signals. Split
// on .!? followed by whitespace + uppercase / paren.
const SENT_SPLIT = /(?<=[.!?])\s+(?=[A-Z(])/g;

function splitSentences(text) {
  if (!text) return [];
  return String(text).split(SENT_SPLIT).map((s) => s.trim()).filter((s) => s.length >= 12);
}

function parseNumber(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/[,_\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Find any dataset already known for this paper that's mentioned in the
// given sentence. Returns the canonical name or null.
function findDatasetInSentence(sentence, datasetsForPaper) {
  if (!sentence || datasetsForPaper.size === 0) return null;
  const lower = sentence.toLowerCase();
  for (const { canonical, raw } of datasetsForPaper.values()) {
    if (!raw) continue;
    // Match the raw form OR the canonical form (slug). Use word boundary
    // where the form is alphabetic; for slugs with dashes, fall back to
    // substring (case-insensitive).
    const rawLow = raw.toLowerCase();
    if (lower.includes(rawLow)) return canonical;
    const canonLow = canonical.toLowerCase();
    if (canonLow.length >= 3 && lower.includes(canonLow)) return canonical;
  }
  return null;
}

// Recognise the split type from a sentence ("test", "validation", "train").
function detectSplit(sentence) {
  const lower = sentence.toLowerCase();
  if (/\btest\b/.test(lower)) return 'test';
  if (/\bvalidation\b|\bdev\b/.test(lower)) return 'val';
  if (/\btraining\b|\btrain\b/.test(lower)) return 'train';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// sample_size extractor
// ─────────────────────────────────────────────────────────────────────────

async function extractSampleSize(paperId, opts = {}) {
  const chunks = eligibleChunks(paperId, SAMPLE_SIZE_SECTIONS);
  if (chunks.length === 0) {
    return _writeUnknownSampleSize(paperId, 'no_chunks');
  }

  // Collect candidate (value, sentence, chunk_id, page) records.
  const candidates = [];
  for (const ch of chunks) {
    const sentences = splitSentences(ch.text);
    for (const sent of sentences) {
      for (const re of SAMPLE_SIZE_PATTERNS) {
        const m = sent.match(re);
        if (!m) continue;
        const n = parseNumber(m[1]);
        if (n === null || n < SAMPLE_SIZE_MIN || n > SAMPLE_SIZE_MAX) continue;
        candidates.push({ value: n, sentence: sent, chunk_id: ch.chunk_id, page: ch.page_first });
      }
    }
  }
  if (candidates.length === 0) {
    return _writeUnknownSampleSize(paperId, 'no_numeric_candidate');
  }

  // Largest plausible number first (it's usually the total study N rather
  // than a sub-experiment count). NLI-verify candidates in that order;
  // stop at the first that passes.
  candidates.sort((a, b) => b.value - a.value);
  const maxChecks = opts.maxChecks ?? 5;
  for (const c of candidates.slice(0, maxChecks)) {
    const v = await nli.verifyEntailment(c.sentence, SAMPLE_SIZE_HYPOTHESIS);
    if (v.entail >= SAMPLE_SIZE_THRESHOLD && v.label === 'entailment') {
      const provId = store.recordProvenance({
        mechanism: 'regex+nli',
        model: nli.MODEL,
        chunk_id: c.chunk_id,
        page: c.page,
        raw_text: c.sentence,
        classifier_scores: { entailment: v.entail, neutral: v.neutral, contradiction: v.contradict },
        confidence: v.entail,
      });
      store.exec('DELETE FROM paper_field WHERE paper_id = ? AND field_name = ?', [paperId, 'sample_size']);
      store.exec(
        `INSERT INTO paper_field (paper_id, field_name, field_value, field_type, provenance_id)
         VALUES (?, 'sample_size', ?, 'number', ?)`,
        [paperId, String(c.value), provId],
      );
      return {
        field: 'sample_size', value: c.value, confidence: v.entail,
        page: c.page, chunk_id: c.chunk_id, quote: c.sentence,
      };
    }
  }
  return _writeUnknownSampleSize(paperId, 'nli_rejected', candidates[0]);
}

// Write 'unknown' (not empty string) to keep the value model consistent
// with bool3 and categorical: "extractor ran, found no convincing
// candidate". The detector layer can distinguish this from missing rows
// (paper never extracted) by the presence of the row at all.
function _writeUnknownSampleSize(paperId, reason, nearMiss = null) {
  const provId = store.recordProvenance({
    mechanism: `unknown:${reason}`,
    raw_text: nearMiss?.sentence ?? null,
    chunk_id: nearMiss?.chunk_id ?? null,
    page: nearMiss?.page ?? null,
    confidence: 0,
  });
  store.exec('DELETE FROM paper_field WHERE paper_id = ? AND field_name = ?', [paperId, 'sample_size']);
  store.exec(
    `INSERT INTO paper_field (paper_id, field_name, field_value, field_type, provenance_id)
     VALUES (?, 'sample_size', 'unknown', 'number', ?)`,
    [paperId, provId],
  );
  return { field: 'sample_size', value: null, reason };
}

// ─────────────────────────────────────────────────────────────────────────
// results extractor
// ─────────────────────────────────────────────────────────────────────────

async function extractResults(paperId, opts = {}) {
  const resolver = await getMetricsResolver();
  const chunks = eligibleChunks(paperId, RESULTS_SECTIONS);
  if (chunks.length === 0) return { field: 'results', n_found: 0, reason: 'no_eligible_chunks' };

  // Build a regex from the metric vocabulary's full alias set so we
  // catch every named form. Sort longer aliases first to prevent
  // shorter ones from grabbing prefixes ("F" before "F1").
  const metricForms = [];
  for (const [canonical, entry] of resolver._entries) {
    metricForms.push({ form: canonical, canonical });
    metricForms.push({ form: entry.label, canonical });
    for (const a of entry.aliases) metricForms.push({ form: a, canonical });
  }
  metricForms.sort((a, b) => b.form.length - a.form.length);

  // Precompile a combined regex. Escape regex-special chars in each form.
  // We capture: (metric_form) ... separator ... (number)
  // Allow up to 30 chars between metric and number, including words like
  // "score", "of", "=", ":", "is".
  const escFormUnion = metricForms
    .map((mf) => mf.form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const resultsRe = new RegExp(
    `\\b(${escFormUnion})\\b(?:\\s+(?:score|value|metric|of|=|:|is|reaches|achieves|achieving|hits|reached|reaching|attains|equal[ing]*|approximately|about))?\\s*[:=]?\\s*${NUMBER_RE}`,
    'gi',
  );

  // Pull this paper's dataset-like entity usages for in-sentence
  // attachment. The user's entity_types may use a different label than
  // 'dataset' (e.g. 'corpus', 'benchmark', 'dataset_or_corpus'); we accept
  // any kind whose name resembles dataset / corpus / benchmark.
  const DATASET_RE = /(dataset|corpus|benchmark)/i;
  const allKinds = store.query(`SELECT DISTINCT kind FROM name_usage WHERE paper_id = ?`, [paperId])
    .map((r) => r.kind)
    .filter((k) => DATASET_RE.test(k || ''));
  const datasetsForPaper = new Map();
  if (allKinds.length > 0) {
    const placeholders = allKinds.map(() => '?').join(',');
    const datasetRows = store.query(
      `SELECT canonical, raw FROM name_usage WHERE paper_id = ? AND kind IN (${placeholders})`,
      [paperId, ...allKinds],
    );
    for (const r of datasetRows) datasetsForPaper.set(r.canonical, r);
  }

  // Wipe prior results for this paper (idempotent re-runs).
  store.exec('DELETE FROM results WHERE paper_id = ?', [paperId]);

  let nFound = 0;
  for (const ch of chunks) {
    for (const sent of splitSentences(ch.text)) {
      // Reset regex state per sentence.
      resultsRe.lastIndex = 0;
      const found = [];
      let m;
      while ((m = resultsRe.exec(sent)) !== null) {
        const metricForm = m[1];
        const value = parseNumber(m[2]);
        if (value === null || value < VALUE_MIN || value > VALUE_MAX) continue;
        // Map the matched form back to canonical via the resolver.
        const r = await resolver.canonicalise(metricForm);
        if (!r.canonical) continue;
        found.push({ canonical: r.canonical, value, raw: m[0] });
      }
      if (found.length === 0) continue;

      // NLI-verify ONCE per sentence (not per result), since the same
      // sentence often reports multiple metrics.
      const v = await nli.verifyEntailment(sent, RESULTS_HYPOTHESIS);
      if (!(v.entail >= RESULTS_THRESHOLD && v.label === 'entailment')) continue;

      const dataset = findDatasetInSentence(sent, datasetsForPaper);
      const split = detectSplit(sent);

      for (const r of found) {
        const provId = store.recordProvenance({
          mechanism: 'regex+nli',
          model: nli.MODEL,
          chunk_id: ch.chunk_id,
          page: ch.page_first,
          raw_text: sent,
          classifier_scores: { entailment: v.entail, neutral: v.neutral, contradiction: v.contradict },
          confidence: v.entail,
        });
        store.exec(
          `INSERT INTO results
             (paper_id, metric, value, dataset, split, page, mechanism, raw_text, provenance_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [paperId, r.canonical, r.value, dataset, split, ch.page_first, 'regex+nli', r.raw, provId],
        );
        nFound++;
      }
    }
  }
  return { field: 'results', n_found: nFound };
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run sample_size + results extractors for one paper.
 *
 * opts:
 *   only — subset: ['sample_size'] | ['results'] | both
 */
export async function extractNumerical(paperId, opts = {}) {
  await store.init();
  const set = new Set(opts.only && opts.only.length ? opts.only : ['sample_size', 'results']);
  const results = [];
  if (set.has('sample_size')) {
    try { results.push(await extractSampleSize(paperId, opts)); }
    catch (e) { results.push({ field: 'sample_size', value: null, error: e?.message || String(e) }); }
  }
  if (set.has('results')) {
    try { results.push(await extractResults(paperId, opts)); }
    catch (e) { results.push({ field: 'results', n_found: 0, error: e?.message || String(e) }); }
  }
  return results;
}

export const NUMERICAL_FIELDS = ['sample_size', 'results'];
