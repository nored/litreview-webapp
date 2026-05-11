// search_quality.mjs
//
// Stage 1 quality helpers. Two distinct features that share the embedding
// substrate:
//
//   1. Topic-drift guard. Each search query (auto-suggested or hand-written)
//      gets embedded and cosine-scored against the topic centroid. Below
//      ~0.4 the query is wandering off-topic; above ~0.7 it's tightly
//      aligned. Surface the score so the student can sanity-check before
//      hitting Run search and polluting candidates_raw.csv.
//
//   2. Semantic near-duplicate detection. Runs paraphraseMining across the
//      `papers` vector store. Pairs above the threshold are likely the same
//      paper indexed by different sources (preprint vs published, arXiv ID
//      mismatch, duplicate DOI handling). The student picks a winner; the
//      loser gets marked exclude with a "near-duplicate of paper_X" reason
//      so it stays in the CSV (paper_id stability) but stops bothering them.
//
// Topic embedding is cached in-process by content hash — usually unchanged
// across a session. No persistence; cheap to recompute on next boot.

import crypto from 'node:crypto';
import { readText } from '../storage.mjs';
import { PROTOCOL_FILES } from '../paths.mjs';
import * as vectors from './vectors.mjs';
import * as embedder from './embedder.mjs';
import { paraphraseMining, makeMatrix } from './sbert_utils.mjs';
import * as triage from './triage.mjs';

const PAPERS = 'papers';

// ---------------------------------------------------------------------------
// Topic embedding (cached in-process)
// ---------------------------------------------------------------------------

let _topicCache = null; // { hash, embedding }

function topicHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

async function readTopicText() {
  const md = await readText(PROTOCOL_FILES.topic, '');
  // Pull title + description out without fully parsing the markdown — same
  // approach as the AI suggest button uses on the client side.
  const titleMatch = md.match(/title:\s*(.+)/);
  const descMatch = md.match(/description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/);
  const title = titleMatch?.[1]?.trim() ?? '';
  const desc = descMatch?.[1]?.split('\n').map((l) => l.replace(/^[ \t]{2}/, '')).join('\n').trim() ?? '';
  return `${title}\n\n${desc}`.trim();
}

async function topicEmbedding() {
  const text = await readTopicText();
  if (!text) return null;
  const hash = topicHash(text);
  if (_topicCache && _topicCache.hash === hash) return _topicCache.embedding;
  const r = await embedder.embed([text]);
  const e = r.data; // already L2-normalized
  _topicCache = { hash, embedding: e };
  return e;
}

// Public: drop the cached topic embedding (e.g. after a topic.md save).
export function invalidateTopicCache() {
  _topicCache = null;
}

// ---------------------------------------------------------------------------
// Query drift scoring
// ---------------------------------------------------------------------------

function dotF32(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Rate each query by cosine to the topic embedding. Returns
// [{ query, drift_score }] in the same order as the input. drift_score is
// null for empty queries; null for all queries if the topic is empty.
export async function scoreQueriesAgainstTopic(queries) {
  const list = Array.isArray(queries) ? queries.map((q) => String(q || '').trim()) : [];
  if (list.length === 0) return [];
  const topic = await topicEmbedding();
  if (!topic) {
    return list.map((q) => ({ query: q, drift_score: null, reason: 'topic empty' }));
  }
  const nonEmpty = list.map((q, i) => ({ q, i })).filter(({ q }) => q.length > 0);
  if (nonEmpty.length === 0) {
    return list.map((q) => ({ query: q, drift_score: null }));
  }
  const r = await embedder.embed(nonEmpty.map(({ q }) => q));
  const out = list.map((q) => ({ query: q, drift_score: q ? null : null }));
  for (let n = 0; n < nonEmpty.length; n++) {
    const { i } = nonEmpty[n];
    const row = r.data.subarray(n * r.dim, (n + 1) * r.dim);
    out[i] = { query: list[i], drift_score: dotF32(row, topic) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Near-duplicate detection
// ---------------------------------------------------------------------------

// Run paraphraseMining over the papers store and return high-similarity
// pairs. Threshold defaults to 0.92 — empirically the noise floor for
// "different papers same field" is around 0.85 and bona fide duplicates
// (preprint vs published) score 0.95+. We err toward the conservative end
// so the student isn't asked to merge real-but-similar work.
export async function findNearDuplicates({ threshold = 0.92, maxPairs = 500 } = {}) {
  const { ids, meta, matrix } = await vectors.loadMatrix(PAPERS);
  if (matrix.rows < 2) return { ok: true, pairs: [] };
  const M = makeMatrix(matrix.rows, matrix.dim, matrix.data);
  const triples = paraphraseMining(M, {
    topK: 5,            // each row's 5 nearest neighbours, before threshold
    minScore: threshold,
    maxPairs,
  });
  // Only emit pairs at-or-above the threshold (paraphraseMining respects
  // minScore but it's worth being explicit).
  const pairs = [];
  for (const [score, i, j] of triples) {
    if (score < threshold) continue;
    pairs.push({
      score,
      a: {
        row_index: meta[i]?.row_index ?? Number(ids[i]),
        title: meta[i]?.title || '',
        year: meta[i]?.year || '',
        doi: meta[i]?.doi || '',
        venue: meta[i]?.venue || '',
        triage_label: meta[i]?.triage_label || '',
      },
      b: {
        row_index: meta[j]?.row_index ?? Number(ids[j]),
        title: meta[j]?.title || '',
        year: meta[j]?.year || '',
        doi: meta[j]?.doi || '',
        venue: meta[j]?.venue || '',
        triage_label: meta[j]?.triage_label || '',
      },
    });
  }
  return { ok: true, pairs };
}

// Resolve a near-duplicate pair: keep one row, mark the other exclude.
// We don't physically delete rows from candidates_raw.csv because that
// would break row_index references everywhere downstream. Marking exclude
// + reason keeps the CSV stable and the student gets a paper trail.
export async function resolveDuplicate({ keep_row_index, drop_row_index }) {
  const reason = `near-duplicate of row ${keep_row_index} (semantic dedup)`;
  return triage.setDecision({
    row_index: drop_row_index,
    label: 'exclude',
    reason,
  });
}
