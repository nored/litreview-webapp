// note_drafter.mjs
//
// Stage 4 deep-read context assembly. The CLI template's procedure is to
// read the FULL PDF and produce one structured note per paper, resetting
// context between papers. The webapp can't fit a 20-page PDF in a short-
// context local LLM (WebLLM), so we instead split the note into seven
// parallel LLM calls — one per note section + one for the structured
// frontmatter — and feed each call the FULL content of its relevant PDF
// section (not just top-K chunks). Result: each call has tight, focused
// context; the seven together cover the full paper; total context per
// call stays under ~4K tokens which fits every provider we support.
//
// Each call also gets a section-specific system prompt enforcing the
// schema's expectations for that field (e.g. "stated limitations: only
// what the authors themselves admit; no inference"). The client runs the
// seven calls in parallel and streams results into the note form.
//
// Architecture point of contention: assemble bundles SERVER-side (this
// file) so the client just passes them through to the LLM. Keeps PDF
// chunking + section routing in one place, isomorphic with CLI tooling
// that could later be added.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PDFS_DIR, NOTES_DIR, PROTOCOL_FILES } from '../paths.mjs';
import { fileExists, readText } from '../storage.mjs';
import { chunksForPdf } from './pdf_chunks.mjs';
import { parseTopic } from './topic_md.mjs';
import { parseNoteMd } from './notes.mjs';
import * as vectors from './vectors.mjs';
import * as embedder from './embedder.mjs';

// Maximum chars per bundle. Keeps even WebLLM (8K-token context) under
// half a context window per call. Approximation: 4 chars ≈ 1 token, so
// 3000 chars ≈ 750 tokens of source text per call.
const MAX_BUNDLE_CHARS = 3000;
// How many chunks per field we retrieve via embedding similarity before
// concatenating. Picking too few risks missing context; too many wastes
// the cap. 6 × ~400-word chunks ≈ 2400 words at the upper bound.
const TOPK_PER_FIELD = 6;

// Per-note-field anchor queries. Each query is short and concrete,
// optimised to land on the right *content* via embedding similarity —
// regardless of what the original section heading says or whether the
// chunker labelled it correctly. This is the actual RAG. The chunker's
// section labels are kept around as informational metadata (we surface
// them in the response for the UI) but they are NOT filter criteria.
const FIELD_QUERIES = {
  problem_statement:
    'the problem this paper addresses, motivation, research question, what gap in the field this paper fills',
  method_summary:
    'how the paper solves the problem: input, model, algorithm, architecture, technique, output',
  ground_truth_and_evaluation:
    'evaluation methodology, datasets, benchmarks, metrics, ground truth source, number of cases, baseline comparison',
  stated_limitations:
    'limitations the authors themselves admit, weaknesses, threats to validity, what does not work, caveats',
  gaps_this_paper_opens:
    'future work, open questions, what remains unaddressed, what the authors leave for follow-up',
  relevance_to_thesis_topic:
    'core contribution and applicability of this work to other research, central thesis claims',
};

// Frontmatter draft draws from broader content — it touches every
// structured field. We use a generic anchor query that spans the paper's
// methodological skeleton.
const FRONTMATTER_QUERY =
  'paper contribution, methodology, datasets used, evaluation metrics, results, limitations';

// In-memory cache of per-paper chunk embeddings + bundles. Populated by
// assembleSectionBundles, read by groundSection. Lets grounding annotate
// paragraphs with page references without re-extracting and re-embedding
// the PDF every time. Bounded LRU of GROUND_CACHE_MAX entries.
const GROUND_CACHE_MAX = 8;
const _groundCache = new Map();  // paperId -> { chunks, chunkEmbedF32, dim, bundles, ts }

function groundCachePut(paperId, entry) {
  _groundCache.delete(paperId); // refresh order
  _groundCache.set(paperId, { ...entry, ts: Date.now() });
  // Evict oldest until under cap.
  while (_groundCache.size > GROUND_CACHE_MAX) {
    const oldestKey = _groundCache.keys().next().value;
    _groundCache.delete(oldestKey);
  }
}
function groundCacheGet(paperId) {
  return _groundCache.get(paperId) || null;
}

// How many already-noted papers we surface as "related papers" context
// for the drafter. The drafter uses these to make comparative claims
// like "unlike [paper_5], this work also covers X". Three is a sweet
// spot — enough variety, small enough that we don't blow the prompt cap.
const RELATED_NOTES_TOPK = 3;

// Minimum cosine similarity for a note to qualify as "related". Below
// this is too tangential to cite. Calibrated for bge-small-en-v1.5
// against the focal paper's title+abstract.
const RELATED_NOTES_MIN_SIM = 0.30;

// ---------------------------------------------------------------------------
// Deterministic frontmatter extraction (no LLM call)
// ---------------------------------------------------------------------------
//
// Several frontmatter fields are well-formed enough that a local embedder
// + regex can extract them faster and more consistently than an LLM:
//   - category               → cosine to user's category enum
//   - method.family          → cosine to user's method-family enum
//   - relevance.relevance_to_topic → cosine to topic embedding (binned)
//   - evaluation.metrics     → regex over evaluation bundle (~30 known names)
//   - evaluation.baseline_compared  → keyword heuristic
//   - evaluation.has_uncertainty_quantification → keyword heuristic
//   - ground_truth.case_count → regex over evaluation bundle
//   - ground_truth.external  → keyword heuristic on evaluation bundle
//   - quality_flags.hobby_project_scale / self_constructed_ground_truth → heuristics
//
// Free-text fields (primary_contribution, method.specific, novelty_strength)
// stay in the LLM path because they require synthesis. The client may skip
// the LLM frontmatter call entirely if it's happy with extracted fields
// only, or merge LLM-produced text fields on top.

// Curated metric vocabulary. Word-bounded, case-insensitive. Curated, not
// exhaustive — students can edit in the form if their paper uses something
// unusual.
const METRIC_VOCAB = [
  'precision', 'recall', 'f1', 'f-score', 'f score', 'accuracy',
  'auroc', 'auc-roc', 'auprc', 'auc',
  'mae', 'mse', 'rmse', 'mape', 'r-squared', 'r2',
  'bleu', 'rouge', 'meteor', 'cider', 'spice',
  'exact match', 'em',
  'iou', 'miou', 'dice', 'hausdorff',
  'top-1', 'top-5', 'top-10',
  'mrr', 'ndcg', 'map',
  'perplexity', 'cross-entropy', 'log-likelihood',
  'kappa', 'cohen kappa', 'fleiss kappa',
  'sensitivity', 'specificity',
  'pearson', 'spearman',
];

// Heuristic regexes for the boolean/extracted fields.
const CASE_COUNT_RE = /\b(\d{2,7}(?:[,.]\d{3})*)\s+(test\s+cases|test\s+examples|samples|instances|images|examples|articles|sentences|documents|papers|tweets|users|participants|subjects|patients|cases|videos|recordings|sessions|trials|observations)\b/i;
const BASELINE_HINTS = /\b(baseline|baselines|compared?\s+(?:to|against|with)\s+\w+|state[\s-]of[\s-]the[\s-]art|sota)\b/i;
const UQ_HINTS = /\b(confidence\s+intervals?|standard\s+deviations?|standard\s+errors?|error\s+bars?|uncertainty\s+quantification|bootstrap|95%\s+ci)\b/i;
const HOBBY_HINTS = /\b(single\s+gpu|consumer\s+gpu|laptop|colab|reproducible\s+in\s+a\s+(?:weekend|day)|no\s+training\s+required)\b/i;
const SELF_GT_HINTS = /\b(?:we|the\s+authors)\s+(?:annotated|labeled|labelled|created|constructed|built|curated)\s+(?:our|a|the)\s+(?:own\s+)?(?:ground\s+truth|dataset|benchmark|test\s+set|labels|corpus)\b/i;
const EXTERNAL_GT_HINTS = /\b(public\s+(?:dataset|benchmark)|standard\s+benchmark|widely[\s-]used\s+dataset|established\s+benchmark)\b/i;
const REPRODUCIBLE_HINTS = /\b(code\s+is\s+available|github\.com|data\s+is\s+(?:available|released)|we\s+release|publicly\s+available)\b/i;

function findMetrics(text) {
  if (!text) return [];
  const found = new Set();
  const lower = text.toLowerCase();
  for (const m of METRIC_VOCAB) {
    const pattern = new RegExp(`\\b${m.replace(/[-.]/g, '[-.]?')}\\b`, 'i');
    if (pattern.test(lower)) found.add(m.replace(/[\s-]+/g, '_').replace('f_score', 'f1'));
  }
  return Array.from(found);
}

function findCaseCount(text) {
  if (!text) return 0;
  const m = text.match(CASE_COUNT_RE);
  if (!m) return 0;
  const n = parseInt(String(m[1]).replace(/[,.]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Cosine via dot product on unit-normalized vectors (the encoder emits
// normalised). Returns top-K labels by score, with the score for each.
function topByEmbedding(labelVecs, refVec, k = 3, minScore = 0.0) {
  const out = labelVecs.map((row) => ({
    label: row.label,
    score: dotF32(row.vec, refVec),
  })).filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

function dotF32(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Embed a list of short text labels and return [{ label, vec }] so the
// caller can run cosine matches against any reference vector.
async function embedLabels(labels) {
  const clean = labels.filter((l) => l && l.trim());
  if (clean.length === 0) return [];
  const r = await embedder.embed(clean);
  const dim = r.dim;
  return clean.map((label, i) => ({
    label,
    vec: new Float32Array(r.data.subarray(i * dim, (i + 1) * dim)),
  }));
}

// Run the deterministic extraction. Returns the same shape the client's
// applyRichFrontmatterDraft expects.
export async function extractFrontmatterByEmbeddings(opts) {
  const {
    bundles,             // from assembleSectionBundles
    paperMeta,           // { title, authors, year, venue, abstract_short }
    topic,               // { title, description, categories, method_families }
    categoriesEnum,
    methodFamiliesEnum,
  } = opts;

  // We use the abstract+intro bundle as the "what is this paper about?"
  // anchor for category and relevance, and the method bundle for method
  // family classification. Falls back to title alone if everything's empty.
  const aboutText = (
    bundles.relevance_to_thesis_topic?.text ||
    bundles.problem_statement?.text ||
    paperMeta.abstract_short ||
    paperMeta.title ||
    ''
  ).trim();
  const methodText = (bundles.method_summary?.text || aboutText).trim();
  const evalText = (bundles.ground_truth_and_evaluation?.text || '').trim();
  const limText = (bundles.stated_limitations?.text || '').trim();
  const topicText = `${topic.title || ''}\n\n${topic.description || ''}`.trim();

  // Embed all the anchors and labels in one batch call.
  const wantToEmbed = [aboutText, methodText, topicText];
  const presentIdx = wantToEmbed.map((t, i) => ({ t, i })).filter(({ t }) => t.length > 0);
  if (presentIdx.length === 0) {
    return { extracted: false };
  }
  const anchorR = await embedder.embed(presentIdx.map(({ t }) => t));
  const dim = anchorR.dim;
  const aboutVec = presentIdx[0]?.i === 0 ? new Float32Array(anchorR.data.subarray(0, dim)) : null;
  const methodVec = (() => {
    const i = presentIdx.findIndex(({ i: ix }) => ix === 1);
    return i >= 0 ? new Float32Array(anchorR.data.subarray(i * dim, (i + 1) * dim)) : null;
  })();
  const topicVec = (() => {
    const i = presentIdx.findIndex(({ i: ix }) => ix === 2);
    return i >= 0 ? new Float32Array(anchorR.data.subarray(i * dim, (i + 1) * dim)) : null;
  })();

  // Enum label embeddings. Empty enums → skip those fields.
  const [categoryLabels, methodFamilyLabels] = await Promise.all([
    embedLabels(categoriesEnum || []),
    embedLabels(methodFamiliesEnum || []),
  ]);

  const extracted = {};

  // 1. Categories — cosine to user's category list, take top 1-3 above a
  // floor of 0.45 (avoids forcing an unrelated category onto out-of-topic
  // papers).
  if (categoryLabels.length && aboutVec) {
    const hits = topByEmbedding(categoryLabels, aboutVec, 3, 0.45);
    if (hits.length > 0) {
      extracted.categories = hits.map((h) => h.label);
      extracted.categories_scores = hits.map((h) => h.score);
    } else {
      extracted.categories = ['other'];
    }
  }

  // 2. Method family — cosine to user's method-family list, top 1, no
  // strict floor (papers always have *some* method).
  if (methodFamilyLabels.length && methodVec) {
    const hits = topByEmbedding(methodFamilyLabels, methodVec, 1);
    if (hits.length > 0 && hits[0].score >= 0.35) {
      extracted.method_family = hits[0].label;
      extracted.method_family_score = hits[0].score;
    } else {
      extracted.method_family = 'other';
    }
  }

  // 3. Relevance to topic — cosine to topic embedding, binned.
  if (topicVec && aboutVec) {
    const sim = dotF32(topicVec, aboutVec);
    extracted.relevance_to_topic_cosine = sim;
    if (sim >= 0.65) extracted.relevance_to_topic = 'core';
    else if (sim >= 0.45) extracted.relevance_to_topic = 'adjacent';
    else extracted.relevance_to_topic = 'peripheral';
    // Must-cite heuristic: cosine ≥ 0.70 = must cite.
    extracted.must_cite = sim >= 0.70;
  }

  // 4. Evaluation metrics + case count (regex over the eval bundle).
  if (evalText) {
    extracted.metrics = findMetrics(evalText);
    extracted.case_count = findCaseCount(evalText);
    extracted.baseline_compared = BASELINE_HINTS.test(evalText);
    extracted.has_uncertainty_quantification = UQ_HINTS.test(evalText);
    extracted.external_ground_truth = EXTERNAL_GT_HINTS.test(evalText) && !SELF_GT_HINTS.test(evalText);
    extracted.self_constructed_ground_truth = SELF_GT_HINTS.test(evalText);
    extracted.reproducible = REPRODUCIBLE_HINTS.test(evalText);
  }

  // 5. Quality flags (heuristic across method + abstract).
  const combined = `${methodText}\n${aboutText}`;
  extracted.hobby_project_scale = HOBBY_HINTS.test(combined);

  // 6. Limitations (paragraph-level extraction). Look for known marker
  // phrases inside the limitations bundle and return matching paragraphs.
  if (limText) {
    const markers = /\b(limit(?:ation)?s?|however,|caveat|threat\s+to\s+validity|we\s+(?:do\s+not|cannot)|future\s+work\s+(?:will|should|could))\b/i;
    const paragraphs = limText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const limited = paragraphs.filter((p) => markers.test(p)).slice(0, 4);
    if (limited.length > 0) extracted.limitations = limited;
  }

  extracted.extracted = true;
  extracted.source = 'embedding+regex';
  return extracted;
}

// Compose all seven bundles for a paper. Returns:
//   {
//     paper_id,
//     chunks_available,
//     paper_meta: { title, authors, year, venue, abstract_short },
//     topic: { title, description, categories, method_families },
//     bundles: {
//       problem_statement:        { text, source_sections, char_count },
//       method_summary:           { ... },
//       ground_truth_and_evaluation: { ... },
//       stated_limitations:       { ... },
//       gaps_this_paper_opens:    { ... },
//       relevance_to_thesis_topic:{ ... },
//       frontmatter:              { ... },
//     }
//   }
//
// `chunks_available: false` means the paper has no PDF chunked — the
// client falls back to abstract-only drafting (current behaviour).
// Pull a small set of already-noted related papers from the notes
// vector store, anchored on the focal paper's title+abstract. The
// drafter weaves them into prompts so it can make comparative claims
// ("unlike [paper_5], …") instead of writing each note in isolation.
//
// Returns: [{ paper_id, title, authors, year, primary_contribution,
//             gaps_opened, similarity }, …]   — empty if the notes
// store is empty or the focal paper has no usable title+abstract.
async function assembleRelatedNotes(focalPaperId, paperMeta) {
  const queryText = [
    paperMeta?.title || '',
    paperMeta?.abstract_short || '',
  ].filter(Boolean).join('\n').trim();
  if (!queryText) return [];

  let q;
  try {
    const r = await embedder.embed([queryText]);
    q = new Float32Array(r.data);
  } catch {
    return [];
  }

  // Pull a few extra candidates so we can drop the focal paper and any
  // low-similarity tail without falling short of TOPK.
  let hits;
  try {
    hits = await vectors.search('notes', q, { topK: RELATED_NOTES_TOPK + 3 });
  } catch {
    return [];
  }

  const out = [];
  for (const hit of hits) {
    if (out.length >= RELATED_NOTES_TOPK) break;
    const pid = hit.meta?.paper_id || String(hit.id);
    if (!pid || pid === String(focalPaperId)) continue;
    if (typeof hit.score === 'number' && hit.score < RELATED_NOTES_MIN_SIM) continue;

    const noteFile = path.join(NOTES_DIR, `paper_${pid}.md`);
    let md;
    try { md = await fs.readFile(noteFile, 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = parseNoteMd(md); } catch { continue; }
    const fm = parsed.frontmatter || {};
    const body = parsed.body || {};
    out.push({
      paper_id: pid,
      title: fm.title || hit.meta?.title || '',
      authors: Array.isArray(fm.authors) ? fm.authors.join(', ') : (fm.authors || ''),
      year: fm.year || '',
      primary_contribution: fm.claims?.primary_contribution || '',
      method_family: fm.method?.family || hit.meta?.method_family || '',
      gaps_opened: (body.gaps_this_paper_opens || '').slice(0, 360),
      similarity: typeof hit.score === 'number' ? hit.score : null,
    });
  }
  return out;
}

export async function assembleSectionBundles(paperId, candidateRow = null) {
  const pid = String(paperId);
  const pdfPath = path.join(PDFS_DIR, `paper_${pid}.pdf`);
  const topic = await readTopic();
  const paperMeta = candidateRow ? candidateMeta(candidateRow) : { title: '', authors: '', year: '', venue: '', abstract_short: '' };

  if (!await fileExists(pdfPath)) {
    return {
      paper_id: pid, chunks_available: false, paper_meta: paperMeta, topic, bundles: emptyBundles(),
    };
  }

  // Re-extract chunks from the PDF on demand. We need the text content for
  // the bundles; vector store only carries embeddings + meta. Extraction
  // is fast (~150ms for a 20-page paper). This also means we don't need
  // the chunks-vectors store to be populated for this paper to work —
  // useful if a student opens a paper before the embed daemon has caught
  // up.
  let chunks;
  try {
    chunks = await chunksForPdf(pdfPath, pid);
  } catch {
    return {
      paper_id: pid, chunks_available: false, paper_meta: paperMeta, topic, bundles: emptyBundles(),
    };
  }
  if (chunks.length === 0) {
    return {
      paper_id: pid, chunks_available: false, paper_meta: paperMeta, topic, bundles: emptyBundles(),
    };
  }

  // RAG: embed each anchor query and the paper's chunks, retrieve the top
  // K most-similar chunks per note field via cosine similarity. Section
  // labels are NOT used as filters — they're brittle. The embedding
  // captures content, not heading wording.
  const fieldKeys = Object.keys(FIELD_QUERIES);
  const queries = fieldKeys.map((k) => FIELD_QUERIES[k]).concat([FRONTMATTER_QUERY]);
  const qEmbed = await embedder.embed(queries);
  const cEmbed = await embedder.embed(chunks.map((c) => c.text || ''));
  const dim = qEmbed.dim;

  function rowAt(buf, i) {
    return buf.subarray(i * dim, (i + 1) * dim);
  }
  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  const bundles = {};
  for (let qi = 0; qi < queries.length; qi++) {
    const q = rowAt(qEmbed.data, qi);
    const scored = chunks.map((c, ci) => ({ c, ci, score: dot(q, rowAt(cEmbed.data, ci)) }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, TOPK_PER_FIELD);
    const parts = [];
    const provenance = [];
    let total = 0;
    for (const { c, ci, score } of top) {
      const text = c.text || '';
      if (!text) continue;
      const remaining = MAX_BUNDLE_CHARS - total;
      if (remaining <= 0) break;
      const slice = text.length <= remaining ? text : text.slice(0, remaining);
      parts.push(slice);
      total += slice.length;
      provenance.push({
        chunk_id: c.id,
        chunk_idx: ci,                         // index into chunks[] / cEmbed; used by grounding
        text: text.slice(0, 1200),             // chunk excerpt — used by grounding pass
        page: c.meta?.page_first || '',
        page_last: c.meta?.page_last || '',
        section_label: c.meta?.section || '',   // informational only
        similarity: score,
      });
      if (total >= MAX_BUNDLE_CHARS) break;
    }
    const fieldName = qi < fieldKeys.length ? fieldKeys[qi] : 'frontmatter';
    bundles[fieldName] = {
      text: parts.join('\n\n'),
      char_count: total,
      provenance,
      // Keep the historical `source_sections` key around for the existing
      // UI string that says "drawn from: introduction, methods" — derive
      // it from the provenance section labels.
      source_sections: Array.from(new Set(provenance.map((p) => p.section_label).filter(Boolean))),
    };
  }

  // Run the deterministic extractor over the bundles. Replaces (most of)
  // the LLM frontmatter call and produces a templated relevance-to-topic
  // body section so the client can skip those LLM calls.
  let extractedFrontmatter = null;
  let relevanceBodyTemplate = null;
  try {
    extractedFrontmatter = await extractFrontmatterByEmbeddings({
      bundles, paperMeta, topic,
      categoriesEnum: topic.categories || [],
      methodFamiliesEnum: topic.method_families || [],
    });
    relevanceBodyTemplate = templateRelevanceBody(extractedFrontmatter, paperMeta, topic);
  } catch (err) {
    // Extraction failures shouldn't kill the bundle response.
    extractedFrontmatter = { extracted: false, error: err.message };
  }

  // Cross-paper context: pull a handful of already-noted papers similar
  // to the focal one so the drafter can make comparative claims. Failure
  // is silent — the drafter still works without related-notes context.
  let relatedNotes = [];
  try {
    relatedNotes = await assembleRelatedNotes(pid, paperMeta);
  } catch { /* ignore */ }

  // Cache chunks + their embeddings for the subsequent grounding pass.
  // groundSection looks them up by paper_id and avoids re-extracting.
  groundCachePut(pid, {
    chunks,
    chunkEmbedF32: new Float32Array(cEmbed.data),
    dim,
    bundles,
  });

  return {
    paper_id: pid,
    chunks_available: true,
    paper_meta: paperMeta,
    topic,
    bundles,
    extracted_frontmatter: extractedFrontmatter,
    templated_relevance_body: relevanceBodyTemplate,
    related_notes: relatedNotes,
  };
}

// ---------------------------------------------------------------------
// Quote grounding — annotate drafted paragraphs with page references
// ---------------------------------------------------------------------
//
// After the drafter produces a section's text, the client calls this
// with `(paperId, field, text)`. We split the text into paragraphs,
// embed each, find the closest chunk (out of the K chunks that the
// drafter actually saw for this field), and append "(pp. X)" or
// "(pp. X-Y)" inline at the end of each paragraph.
//
// Pure embedding pass — no LLM call. Fast: ~50ms per section. If the
// per-paper cache is cold, we trigger assembleSectionBundles which is
// itself O(150ms) per PDF.

// Minimum paragraph length to bother annotating — short fragments (a
// title-line, a "yes" reply) carry no useful claim.
const GROUND_MIN_PARA_CHARS = 40;
// Minimum cosine sim for a chunk match to count. Below this the chunk
// isn't really supporting the paragraph; skip annotation rather than
// add a misleading page ref.
const GROUND_MIN_SIM = 0.30;

export async function groundSection(paperId, field, text) {
  const pid = String(paperId);
  const trimmed = String(text || '').trim();
  if (!trimmed) return { annotated_text: '', paragraphs: [] };

  // Ensure cache. assembleSectionBundles populates it as a side effect.
  let cache = groundCacheGet(pid);
  if (!cache) {
    try {
      await assembleSectionBundles(pid);
      cache = groundCacheGet(pid);
    } catch { /* fall through */ }
  }
  if (!cache) return { annotated_text: trimmed, paragraphs: [] };
  const { chunks, chunkEmbedF32, dim, bundles } = cache;

  // Only chunks that this field actually had in its provenance are valid
  // anchors — the drafter only saw those K. Pull their chunk indices.
  const fieldBundle = bundles?.[field];
  const candidateChunkIdxs = (fieldBundle?.provenance || [])
    .map((p) => p.chunk_idx)
    .filter((i) => typeof i === 'number' && i >= 0 && i < chunks.length);
  // Fall back to all chunks if provenance is missing chunk_idx (legacy
  // bundle response shape).
  const candidates = candidateChunkIdxs.length > 0
    ? candidateChunkIdxs
    : chunks.map((_, i) => i);

  // Split into paragraphs. Annotation lives at the end of each
  // paragraph; leave separators intact so the annotated text re-flows
  // identically.
  const rawParagraphs = trimmed.split(/\n{2,}/);
  // Strip any existing "(pp. ...)" annotations the drafter may have
  // produced or that lived in a prior draft, so we don't stack them.
  const stripped = rawParagraphs.map((p) => p.replace(/\s*\(pp?\.\s*[^)]+\)\s*$/i, '').trim());

  // Embed paragraphs in one batch call.
  const indexable = [];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i].length >= GROUND_MIN_PARA_CHARS) indexable.push(i);
  }
  if (indexable.length === 0) {
    return { annotated_text: trimmed, paragraphs: stripped.map((t) => ({ text: t })) };
  }

  let pEmbed;
  try {
    pEmbed = await embedder.embed(indexable.map((i) => stripped[i]));
  } catch {
    return { annotated_text: trimmed, paragraphs: stripped.map((t) => ({ text: t })) };
  }

  const out = stripped.map((t) => ({ text: t }));

  for (let k = 0; k < indexable.length; k++) {
    const paraIdx = indexable[k];
    const pVec = pEmbed.data.subarray(k * dim, (k + 1) * dim);
    let bestSim = -1;
    let bestChunk = -1;
    for (const ci of candidates) {
      const cVec = chunkEmbedF32.subarray(ci * dim, (ci + 1) * dim);
      let s = 0;
      for (let d = 0; d < dim; d++) s += pVec[d] * cVec[d];
      if (s > bestSim) {
        bestSim = s;
        bestChunk = ci;
      }
    }
    if (bestChunk < 0 || bestSim < GROUND_MIN_SIM) continue;
    const meta = chunks[bestChunk]?.meta || {};
    const pf = meta.page_first;
    const pl = meta.page_last;
    if (!pf) continue;
    const pageRef = (pl && pl !== pf) ? `pp. ${pf}-${pl}` : `p. ${pf}`;
    out[paraIdx].chunk_idx = bestChunk;
    out[paraIdx].page = pf;
    out[paraIdx].page_last = pl || pf;
    out[paraIdx].similarity = bestSim;
    out[paraIdx].text = `${stripped[paraIdx]} (${pageRef})`;
  }

  const annotated = out.map((o) => o.text).join('\n\n');
  return { annotated_text: annotated, paragraphs: out };
}

// Deterministic relevance-to-thesis body section. Composed from the
// extracted relevance bucket + cosine + must-cite + paper meta. Reads
// like one human sentence; the student can polish it without the LLM
// detour. Returns null if we don't have enough signal.
function templateRelevanceBody(extracted, paperMeta, topic) {
  if (!extracted?.extracted || !extracted.relevance_to_topic) return null;
  const sim = extracted.relevance_to_topic_cosine || 0;
  const relevance = extracted.relevance_to_topic; // core | adjacent | peripheral
  const mustCite = !!extracted.must_cite;
  const topicTitle = topic.title || 'the thesis topic';
  const verdicts = {
    core: `This paper sits at the centre of work on ${topicTitle} (cosine similarity ${sim.toFixed(2)} to the topic abstract).`,
    adjacent: `This paper is adjacent to ${topicTitle} (cosine similarity ${sim.toFixed(2)}) — it shares vocabulary and concerns but addresses a related rather than identical problem.`,
    peripheral: `This paper is peripheral to ${topicTitle} (cosine similarity ${sim.toFixed(2)}). It may serve as a methodological reference rather than a topical one.`,
  };
  const citeClause = mustCite
    ? 'The thesis must cite this paper.'
    : (relevance === 'core' ? 'The thesis should cite this paper.' :
       relevance === 'adjacent' ? 'The thesis may cite this paper as context.' :
       'Citation is optional unless the methodology transfers directly.');
  return `${verdicts[relevance]} ${citeClause}`;
}

function emptyBundles() {
  const out = {};
  for (const field of Object.keys(FIELD_QUERIES)) {
    out[field] = { text: '', source_sections: [], provenance: [], char_count: 0 };
  }
  out.frontmatter = { text: '', source_sections: [], provenance: [], char_count: 0 };
  return out;
}

async function readTopic() {
  try {
    const md = await readText(PROTOCOL_FILES.topic, '');
    const t = parseTopic(md);
    return {
      title: t.title || '',
      description: t.description || '',
      categories: t.categories || [],
      method_families: t.method_families || [],
    };
  } catch {
    return { title: '', description: '', categories: [], method_families: [] };
  }
}

function candidateMeta(row) {
  return {
    title: row.title || '',
    authors: row.authors || '',
    year: row.year || '',
    venue: row.venue || '',
    // Keep the abstract small here; the bundle text is the real context.
    // Abstract is fallback when no PDF chunks are available.
    abstract_short: (row.abstract || '').slice(0, 1500),
  };
}

// Legacy compatibility — older endpoint shape used by an earlier
// iteration of stage4. Keeps the same shape (chunks_available + sections
// map) so the deprecated client path still works during the rollout.
export async function getDraftingContextHydrated(paperId) {
  const b = await assembleSectionBundles(paperId);
  return {
    paper_id: b.paper_id,
    chunks_available: b.chunks_available,
    sections: Object.fromEntries(
      Object.keys(FIELD_SECTIONS).map((k) => [
        k,
        b.bundles[k].text
          ? [{ text: b.bundles[k].text, similarity: 1.0, page: '', page_last: '', section: (b.bundles[k].source_sections[0] || '') }]
          : [],
      ]),
    ),
    claims: {},
  };
}
