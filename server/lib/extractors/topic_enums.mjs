// extractors/topic_enums.mjs
//
// Two fields where the enum *values* come from `topic.md` (set by the
// student up front), not from a fixed vocabulary:
//
//   category       — array of categories (multi-label; cosine to each
//                    category prototype; accept those above threshold).
//                    Stored as paper_category rows (many-to-many).
//
//   method_family  — single label from the method_families list.
//                    Stored as paper_field(field_name='method_family').
//
// Both classify via cosine to a "prototype" embedding per label. This
// mirrors how the existing extractor in note_drafter.mjs has been
// classifying these — but rewritten cleanly to write to the new SQLite
// store with proper provenance. The embedder is the same bge-small
// already used elsewhere; no new model dependencies.

import * as store from '../store.mjs';
import * as embedder from '../embedder.mjs';
import * as sbert from '../sbert_utils.mjs';
import { readText } from '../../storage.mjs';
import { PROTOCOL_FILES } from '../../paths.mjs';
import { parseTopic } from '../topic_md.mjs';
import { eligibleChunksWithFallback, annotateMechanism } from './_section_routing.mjs';

// Categories are multi-label; accept labels above this cosine floor.
const CATEGORY_MIN_COSINE = 0.50;
const CATEGORY_MAX_LABELS = 3;
// Method family is single-label. Above this floor the top candidate
// is accepted; below it (or with a too-thin margin over the second
// candidate) the result is 'other'. Higher than before because bge-small
// produces a noisy ~0.4 baseline cosine even for unrelated labels —
// without a meaningful floor every paper got SOME label.
const METHOD_FAMILY_MIN_COSINE = 0.55;
const METHOD_FAMILY_MIN_MARGIN = 0.05;

const CATEGORY_SECTIONS = ['abstract', 'introduction', 'methods'];
const METHOD_FAMILY_SECTIONS = ['methods', 'experimental_setup', 'abstract'];

// Embedding a bare token like "oblivious_ram" produces noisy similarities
// against long paper text. Expanding the label into a discriminative
// sentence template gives cleaner cosines and a higher dynamic range.
function expandCategoryLabel(label) {
  const clean = String(label).replace(/_/g, ' ');
  return `This paper is about ${clean}.`;
}
function expandMethodLabel(label) {
  const clean = String(label).replace(/_/g, ' ');
  return `The methodology used in this paper is ${clean}.`;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function eligibleText(paperId, sectionLabels, budget = 1500, maxChunks = 4) {
  const { rows, tier } = eligibleChunksWithFallback(paperId, sectionLabels, { limit: maxChunks * 2 });
  let total = 0;
  const parts = [];
  const chunkIds = [];
  let firstPage = null;
  let used = 0;
  for (const r of rows) {
    if (used >= maxChunks) break;
    const remaining = budget - total;
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

// Embed a list of label strings into a row matrix. The embedder
// L2-normalises so dot product = cosine.
async function embedLabels(labels) {
  if (!labels || labels.length === 0) return null;
  const r = await embedder.embed(labels);
  return sbert.makeMatrix(labels.length, r.dim, new Float32Array(r.data));
}

async function embedQuery(text) {
  if (!text || !text.trim()) return null;
  const r = await embedder.embed([text]);
  return sbert.makeMatrix(1, r.dim, new Float32Array(r.data));
}

async function loadTopic() {
  const md = await readText(PROTOCOL_FILES.topic, '');
  return parseTopic(md) || {};
}

// ─────────────────────────────────────────────────────────────────────────
// Per-field extraction
// ─────────────────────────────────────────────────────────────────────────

async function extractCategory(paperId, topic) {
  const labels = Array.isArray(topic.categories) ? topic.categories.filter(Boolean) : [];
  if (labels.length === 0) {
    return { field: 'category', accepted: [], reason: 'no_topic_categories' };
  }
  const { text, chunkIds, firstPage, tier } = eligibleText(paperId, CATEGORY_SECTIONS);
  if (!text.trim()) {
    store.exec('DELETE FROM paper_category WHERE paper_id = ?', [paperId]);
    return { field: 'category', accepted: [], reason: 'no_chunks', tier };
  }

  const expandedTexts = labels.map(expandCategoryLabel);
  const labelMat = await embedLabels(expandedTexts);
  const qMat = await embedQuery(text);
  if (!labelMat || !qMat) return { field: 'category', accepted: [], reason: 'embed_failed' };

  const hits = sbert.semanticSearch(qMat, labelMat, {
    topK: labels.length,
    scoreFn: 'dot_score',   // embedder L2-normalises, so dot = cos
  });
  const ranked = hits[0]
    .map((h) => ({ label: labels[h.corpus_id], score: h.score }))
    .sort((a, b) => b.score - a.score);

  // Pick the highest one always; pick further ones if above threshold.
  const accepted = [];
  for (let i = 0; i < ranked.length && accepted.length < CATEGORY_MAX_LABELS; i++) {
    if (i === 0 || ranked[i].score >= CATEGORY_MIN_COSINE) {
      accepted.push(ranked[i]);
    } else {
      break;
    }
  }

  // Persist: provenance row + paper_category rows. We use one provenance
  // entry for the whole multi-label decision (the score distribution
  // contains all per-label scores).
  const scoresObj = {};
  for (const r of ranked) scoresObj[r.label] = r.score;
  const provId = store.recordProvenance({
    mechanism: annotateMechanism('cosine_prototype', tier),
    model: embedder.MODEL,
    chunk_id: chunkIds[0] ?? null,
    page: firstPage,
    raw_text: text.slice(0, 500),
    classifier_scores: scoresObj,
    confidence: accepted[0]?.score ?? 0,
  });

  store.transaction(() => {
    store.exec('DELETE FROM paper_category WHERE paper_id = ?', [paperId]);
    for (const a of accepted) {
      store.exec(
        'INSERT INTO paper_category (paper_id, category) VALUES (?, ?)',
        [paperId, a.label],
      );
    }
    store.exec('DELETE FROM paper_field WHERE paper_id = ? AND field_name = ?', [paperId, 'category']);
    store.exec(
      `INSERT INTO paper_field (paper_id, field_name, field_value, field_type, provenance_id)
       VALUES (?, 'category', ?, 'string', ?)`,
      [paperId, accepted.map((a) => a.label).join(','), provId],
    );
  });

  return {
    field: 'category',
    accepted: accepted.map((a) => ({ label: a.label, score: Number(a.score.toFixed(4)) })),
    tier,
  };
}

async function extractMethodFamily(paperId, topic) {
  let labels = Array.isArray(topic.method_families) ? topic.method_families.filter(Boolean) : [];
  if (labels.length === 0) {
    return { field: 'method_family', value: null, reason: 'no_topic_method_families' };
  }
  if (!labels.includes('other')) labels = [...labels, 'other'];

  const { text, chunkIds, firstPage, tier } = eligibleText(paperId, METHOD_FAMILY_SECTIONS);
  if (!text.trim()) {
    return { field: 'method_family', value: null, reason: 'no_chunks', tier };
  }

  const expandedTexts = labels.map(expandMethodLabel);
  const labelMat = await embedLabels(expandedTexts);
  const qMat = await embedQuery(text);
  if (!labelMat || !qMat) return { field: 'method_family', value: null, reason: 'embed_failed' };

  const hits = sbert.semanticSearch(qMat, labelMat, {
    topK: labels.length,
    scoreFn: 'dot_score',
  });
  const ranked = hits[0]
    .map((h) => ({ label: labels[h.corpus_id], score: h.score }))
    .sort((a, b) => b.score - a.score);

  // Both floor AND margin required. cosine floor alone wasn't enough:
  // bge-small returns 0.4-0.5 cosines for arbitrary-vs-short-token even
  // when the label is unrelated. Requiring a margin over the runner-up
  // catches the "every label scores about the same" case where the
  // result is meaningless.
  const top = ranked[0];
  const second = ranked[1];
  const margin = top && second ? (top.score - second.score) : (top?.score ?? 0);
  const accept = top
    && top.score >= METHOD_FAMILY_MIN_COSINE
    && margin >= METHOD_FAMILY_MIN_MARGIN;
  const value = accept ? top.label : 'other';

  const scoresObj = {};
  for (const r of ranked) scoresObj[r.label] = r.score;
  const provId = store.recordProvenance({
    mechanism: annotateMechanism(accept ? 'cosine_prototype' : 'cosine_prototype_low_confidence', tier),
    model: embedder.MODEL,
    chunk_id: chunkIds[0] ?? null,
    page: firstPage,
    raw_text: text.slice(0, 500),
    classifier_scores: scoresObj,
    confidence: top?.score ?? 0,
  });
  store.exec('DELETE FROM paper_field WHERE paper_id = ? AND field_name = ?', [paperId, 'method_family']);
  store.exec(
    `INSERT INTO paper_field (paper_id, field_name, field_value, field_type, provenance_id)
     VALUES (?, 'method_family', ?, 'enum', ?)`,
    [paperId, value, provId],
  );

  return {
    field: 'method_family',
    value,
    top_score: Number((top?.score ?? 0).toFixed(4)),
    accepted: accept,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run topic-enum extractors (category + method_family) for one paper.
 * Both pull their label sets from topic.md (parsed via topic_md.mjs).
 * Cosine to label-prototype embeddings; no LLM, no NLI involved.
 */
export async function extractTopicEnums(paperId, opts = {}) {
  await store.init();
  const topic = await loadTopic();
  const results = [];
  try { results.push(await extractCategory(paperId, topic)); }
  catch (e) { results.push({ field: 'category', error: e?.message || String(e) }); }
  try { results.push(await extractMethodFamily(paperId, topic)); }
  catch (e) { results.push({ field: 'method_family', error: e?.message || String(e) }); }
  return results;
}

export const TOPIC_ENUM_FIELDS = ['category', 'method_family'];
