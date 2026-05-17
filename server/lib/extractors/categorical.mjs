// extractors/categorical.mjs
//
// Categorical enum-valued fields. Each is classified by zero-shot NLI
// against a fixed label set; the output is the argmax label plus the full
// score distribution recorded as provenance.
//
// Fields covered:
//
//   methodology_type   — survey | experimental | theoretical | observational
//                        | case_study | review | formal
//                        Source: abstract + methods + experimental_setup chunks
//
//   system_domain      — healthcare | legal | finance | education | software
//                        | manufacturing | transportation | other
//                        Source: abstract + introduction + methods chunks
//
//   sample_type        — individual | organisation | mixed | n/a
//                        Source: methods + experimental_setup chunks
//
// Each field gets its own paper_field row with field_type='enum'. The
// chosen value's confidence + the full label distribution land in the
// provenance subtree so downstream detectors can flag low-confidence
// rows for human review.

import * as store from '../store.mjs';
import * as nli from '../nli.mjs';
import { eligibleChunksWithFallback, annotateMechanism } from './_section_routing.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Field definitions
// ─────────────────────────────────────────────────────────────────────────

// Thresholds tuned for distilbert-base-uncased-mnli's output range on
// academic prose. The model produces tighter distributions than bart-
// large-mnli would, so absolute scores sit lower (~0.15-0.35 for the
// argmax label on a true match, not 0.5+). Required margin is small
// because adjacent enum labels often score very close.
const FIELDS = {
  methodology_type: {
    labels: [
      'survey',
      'experimental',
      'theoretical',
      'observational',
      'case study',
      'review',
      'formal',
    ],
    canonicalise: (label) => label.replace(/\s+/g, '_'),
    sections: ['abstract', 'methods', 'experimental_setup'],
    hypothesisTemplate: 'This is a {} study.',
    minConfidence: 0.18,
    minMargin: 0.03,
  },
  system_domain: {
    labels: [
      'healthcare',
      'legal',
      'finance',
      'education',
      'software engineering',
      'manufacturing',
      'transportation',
      'agriculture',
      'energy',
      'security',
      'other',
    ],
    canonicalise: (label) => label.replace(/\s+/g, '_'),
    sections: ['abstract', 'introduction', 'methods'],
    hypothesisTemplate: 'This paper is about the {} domain.',
    minConfidence: 0.18,
    minMargin: 0.02,
  },
  sample_type: {
    labels: [
      'individual',
      'organisation',
      'mixed',
      'not applicable',
    ],
    canonicalise: (label) => label === 'not applicable' ? 'n/a' : label.replace(/\s+/g, '_'),
    sections: ['methods', 'experimental_setup'],
    hypothesisTemplate: 'The unit of study is the {} level.',
    minConfidence: 0.22,
    minMargin: 0.02,
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

// Pull eligible chunks for a field. To stay under NLI's input budget we
// concatenate up to N chunks (head order), capped at a character budget.
// NLI is robust to multi-paragraph input but slow on long sequences;
// 1500 chars is roughly 300-400 tokens which is plenty of context.
const NLI_INPUT_CHAR_BUDGET = 1500;
const NLI_MAX_CHUNKS = 4;

function eligibleText(paperId, sectionLabels) {
  const { rows, tier } = eligibleChunksWithFallback(paperId, sectionLabels, {
    limit: NLI_MAX_CHUNKS * 2,
  });
  let total = 0;
  const parts = [];
  const chunkIds = [];
  let firstPage = null;
  let used = 0;
  for (const r of rows) {
    if (used >= NLI_MAX_CHUNKS) break;
    const remaining = NLI_INPUT_CHAR_BUDGET - total;
    if (remaining <= 0) break;
    const slice = (r.text || '').slice(0, remaining);
    if (!slice.trim()) continue;
    parts.push(slice);
    chunkIds.push(r.chunk_id);
    total += slice.length;
    used++;
    if (firstPage == null) firstPage = r.page_first;
  }
  return { text: parts.join('\n\n'), chunkIds, firstPage, tier };
}

// Idempotent write to paper_field + provenance.
function writeField({ paperId, name, value, provId }) {
  store.exec('DELETE FROM paper_field WHERE paper_id = ? AND field_name = ?', [paperId, name]);
  store.exec(
    `INSERT INTO paper_field (paper_id, field_name, field_value, field_type, provenance_id)
     VALUES (?, ?, ?, 'enum', ?)`,
    [paperId, name, value, provId],
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Per-field extraction
// ─────────────────────────────────────────────────────────────────────────

async function extractOneField(paperId, name, config, opts = {}) {
  const { text, chunkIds, firstPage, tier } = eligibleText(paperId, config.sections);
  if (!text.trim()) {
    const provId = store.recordProvenance({
      mechanism: annotateMechanism('no_chunks', tier || 'whole_paper'),
      raw_text: null,
      confidence: 0,
    });
    writeField({ paperId, name, value: 'unknown', provId });
    return { field: name, value: 'unknown', confidence: 0, reason: 'no_chunks', tier };
  }

  // Zero-shot NLI classify.
  const result = await nli.classify(text, config.labels, {
    hypothesisTemplate: config.hypothesisTemplate,
    multiLabel: false,
  });

  const top = result.label;
  const topScore = result.score;
  const sortedScores = Object.entries(result.scores).sort((a, b) => b[1] - a[1]);
  const secondScore = sortedScores[1]?.[1] ?? 0;
  const margin = topScore - secondScore;

  const accept = topScore >= config.minConfidence && margin >= config.minMargin;
  const canonicalValue = accept ? config.canonicalise(top) : 'unknown';

  const provId = store.recordProvenance({
    mechanism: annotateMechanism(accept ? 'nli_zero_shot' : 'nli_zero_shot_low_confidence', tier),
    model: nli.MODEL,
    chunk_id: chunkIds[0] ?? null,
    page: firstPage,
    raw_text: text.slice(0, 500),
    classifier_scores: { ...result.scores, _margin: margin },
    confidence: topScore,
  });
  writeField({ paperId, name, value: canonicalValue, provId });
  return {
    field: name,
    value: canonicalValue,
    top_raw: top,
    confidence: topScore,
    margin,
    accepted: accept,
    tier,
    full_distribution: result.scores,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run all categorical-enum extractors for one paper. Writes paper_field
 * + provenance rows. Returns per-field summary.
 *
 * opts:
 *   only — subset of FIELDS keys to run
 */
export async function extractCategorical(paperId, opts = {}) {
  await store.init();
  const which = Array.isArray(opts.only) && opts.only.length
    ? opts.only.filter((f) => f in FIELDS)
    : Object.keys(FIELDS);
  const results = [];
  for (const name of which) {
    try {
      const r = await extractOneField(paperId, name, FIELDS[name], opts);
      results.push(r);
    } catch (e) {
      console.warn(`categorical.${name} failed for paper ${paperId}:`, e?.message || e);
      results.push({ field: name, value: null, error: e?.message || String(e) });
    }
  }
  return results;
}

export const CATEGORICAL_FIELDS = Object.keys(FIELDS);
export function getCategoricalConfig(name) { return FIELDS[name] || null; }
