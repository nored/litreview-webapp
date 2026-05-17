// extract_entities_v2.mjs
//
// Phase 2: GLiNER over every paragraph in the v4 store. Replaces the v1
// name_usage / canonical_names path entirely.
//
// IMPORTANT: GLiNER's label is a HINT, not the authoritative entity type.
// The user has been explicit that pre-declared entity types are wrong —
// the type emerges from clustering the spans across the corpus (Phase 3).
// Here we collect spans with a broad set of likely-relevant initial
// types so the model has SOMETHING to query against. The downstream
// cluster step (Phase 3) re-labels each cluster from the actual span
// content + AI auto-labelling.
//
// Operates per paragraph (not chunk) because grobid gave us proper
// paragraph boundaries.

import * as store from './store.mjs';
import * as gliner from './gliner.mjs';

// Broad initial type list. Specific enough that GLiNER produces useful
// spans on technical writing; agnostic enough that no domain is favoured.
// These are SEEDS for the cluster step, not the final taxonomy.
const INITIAL_TYPES = [
  'method', 'technique', 'algorithm',
  'dataset', 'corpus', 'benchmark',
  'tool', 'library', 'software', 'model',
  'system', 'platform', 'hardware',
  'metric', 'measure',
  'concept', 'theory', 'framework',
  'person', 'organisation', 'place',
  'attack', 'vulnerability', 'defense',
  'protocol', 'standard',
];

// Per-paragraph cost is ~200-500 ms on Apple Silicon CPU at batch=1.
// 50-100 paragraphs per paper ≈ 1-2 minutes per paper.
const PARAGRAPH_CHAR_BUDGET = 1800;       // GLiNER's max input
const MIN_PARAGRAPH_LEN = 80;             // skip stubs / table cells that grobid mislabelled
const GLINER_THRESHOLD = 0.40;

/** Extract entity spans from every paragraph of one paper. Writes to
 *  the entity_spans table. Idempotent per paper. */
export async function extractEntitiesForPaper(paperId, opts = {}) {
  await store.init();
  const startMs = Date.now();
  const paragraphs = store.query(
    `SELECT paragraph_id, paper_id, text, page_first, canonical_type
       FROM paragraphs WHERE paper_id = ? ORDER BY paragraph_idx`,
    [paperId],
  );
  if (paragraphs.length === 0) {
    return { paper_id: paperId, error: 'no_paragraphs', hint: 'run grobid ingest first' };
  }

  // Wipe prior entity spans for this paper.
  store.exec('DELETE FROM entity_spans WHERE paper_id = ?', [paperId]);

  let totalSpans = 0;
  const byLabel = {};
  let glinerDegraded = false;
  for (const p of paragraphs) {
    const text = String(p.text || '').slice(0, PARAGRAPH_CHAR_BUDGET);
    if (text.length < MIN_PARAGRAPH_LEN) continue;
    let spans;
    try {
      spans = await gliner.extract(text, INITIAL_TYPES, { threshold: GLINER_THRESHOLD });
    } catch (e) {
      glinerDegraded = true;
      console.warn(`[entities_v2] gliner failed on ${p.paragraph_id}: ${e?.message || e}`);
      continue;
    }
    if (!Array.isArray(spans) || spans.length === 0) continue;
    for (const s of spans) {
      const provId = store.recordProvenance({
        mechanism: 'gliner',
        model: gliner.MODEL,
        chunk_id: p.paragraph_id,
        page: p.page_first ?? null,
        raw_text: s.text,
        classifier_scores: {
          gliner_score: s.score,
          gliner_label: s.label,
          start: s.start ?? null,
          end: s.end ?? null,
        },
        confidence: s.score,
      });
      store.exec(
        `INSERT INTO entity_spans
          (paper_id, paragraph_id, span_text, start_offset, end_offset, gliner_score, gliner_label, cluster_id, provenance_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [p.paper_id, p.paragraph_id, s.text, s.start ?? null, s.end ?? null,
         s.score, s.label, provId],
      );
      totalSpans++;
      byLabel[s.label] = (byLabel[s.label] || 0) + 1;
    }
  }
  await store.flush();
  return {
    paper_id: paperId,
    n_paragraphs_scanned: paragraphs.length,
    n_spans: totalSpans,
    by_initial_label: byLabel,
    gliner_degraded: glinerDegraded,
    elapsed_ms: Date.now() - startMs,
  };
}

export { INITIAL_TYPES };
