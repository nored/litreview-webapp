// extractors/topic_relevance.mjs
//
// Single-field extractor: paper_field.relevance_to_topic ∈
// {core, important, peripheral}. The v1 schema had this as a hand-set
// frontmatter field; v2 needs an automated default so the detectors
// and the catalogue can reason about which papers are spine-of-review.
//
// Algorithm: cosine similarity between the paper's (title + abstract)
// embedding and the topic.md (title + description) embedding.
//   ≥ 0.55   → core
//   ≥ 0.40   → important
//   else     → peripheral
//
// The user can override via PUT /api/v2/papers/:id/fields/relevance_to_topic.
// Re-running this extractor will OVERWRITE the user's edit; the
// orchestrator skips topic_relevance if a user_edit provenance row
// already exists for this paper+field.

import * as store from '../store.mjs';
import * as embedder from '../embedder.mjs';
import { cosSim, makeMatrix } from '../sbert_utils.mjs';
import { readText } from '../../storage.mjs';
import { PROTOCOL_FILES } from '../../paths.mjs';
import { parseTopic } from '../topic_md.mjs';

const FIELD = 'relevance_to_topic';
const CORE_THRESHOLD = 0.55;
const IMPORTANT_THRESHOLD = 0.40;

async function topicPrototypeText() {
  const md = await readText(PROTOCOL_FILES.topic, '');
  const t = parseTopic(md) || {};
  const title = String(t.title || '').trim();
  const desc = String(t.description || '').trim();
  if (!title && !desc) return null;
  return [title, desc].filter(Boolean).join('. ');
}

export async function extractTopicRelevance(paperId, _opts = {}) {
  await store.init();

  // Skip if user has edited this field manually.
  const userEdit = store.query(
    `SELECT 1 FROM paper_field pf
       JOIN provenance p ON p.prov_id = pf.provenance_id
      WHERE pf.paper_id = ? AND pf.field_name = ? AND p.mechanism = 'user_edit'
      LIMIT 1`,
    [paperId, FIELD],
  );
  if (userEdit.length > 0) return { skipped: 'user_edit_present' };

  const topicText = await topicPrototypeText();
  if (!topicText) return { skipped: 'topic_md_empty' };

  const paper = store.query(
    'SELECT title, abstract FROM papers WHERE paper_id = ?',
    [paperId],
  )[0];
  if (!paper) return { skipped: 'paper_not_found' };
  const paperText = [paper.title || '', (paper.abstract || '').slice(0, 800)].filter(Boolean).join('. ');
  if (!paperText.trim()) return { skipped: 'paper_empty' };

  const emb = await embedder.embed([topicText, paperText]);
  const dim = emb.dim;
  // Wrap each row as a 1×dim matrix; cosSim takes matrices and returns
  // a Float32Array of length A.rows * B.rows (row-major). For 1×1 we
  // want index [0].
  const topicMat = makeMatrix(1, dim, new Float32Array(emb.data.slice(0, dim)));
  const paperMat = makeMatrix(1, dim, new Float32Array(emb.data.slice(dim, dim * 2)));
  const simArr = cosSim(topicMat, paperMat);
  const sim = simArr[0];

  let value;
  if (sim >= CORE_THRESHOLD) value = 'core';
  else if (sim >= IMPORTANT_THRESHOLD) value = 'important';
  else value = 'peripheral';

  const provId = store.recordProvenance({
    mechanism: 'cosine_to_prototype',
    model: embedder.MODEL,
    raw_text: paperText.slice(0, 200),
    confidence: sim,
    classifier_scores: { cosine_similarity: sim, threshold_core: CORE_THRESHOLD, threshold_important: IMPORTANT_THRESHOLD },
  });

  store.exec('DELETE FROM paper_field WHERE paper_id = ? AND field_name = ?', [paperId, FIELD]);
  store.exec(
    `INSERT INTO paper_field (paper_id, field_name, field_value, field_type, provenance_id)
     VALUES (?, ?, ?, 'enum', ?)`,
    [paperId, FIELD, value, provId],
  );

  return { value, similarity: sim };
}

export const FIELD_NAME = FIELD;
