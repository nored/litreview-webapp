// gap_detection.mjs
//
// Embedding-derived gap signals for Stage 5 synthesis. Three primitives,
// each compounding on the substrate already in place:
//
//   discoverThemes()        — community-detect note embeddings to surface
//                             the natural thematic structure of the
//                             included corpus. Alternative axis to the
//                             user-authored categories from Setup.
//
//   aggregateLimitations()  — pull `limitations_authors_state` arrays
//                             from every note's frontmatter, embed each
//                             admitted limitation, cluster them. Surfaces
//                             "N papers in your corpus admit limitation X"
//                             — the corpus's own self-criticism as gap
//                             signal, not the LLM's guesses.
//
//   scoreDensityVoid(text)  — given a candidate gap statement (typed
//                             manually or LLM-generated), embed it and
//                             measure cosine to the nearest paper in the
//                             included corpus. High similarity = the gap
//                             is already covered (false positive). Low
//                             similarity = the gap is genuinely empty
//                             space, a real void.
//
// All three respect the architectural principles we established:
//   - No legacy stats (no TF-IDF, no k-means, no HDBSCAN). Community
//     detection only, with k-NN-auto-tuned parameters per the corpus.
//   - Multi-prototype thinking: themes are sets of paper communities,
//     not a single average; limitations are clusters not a single summary.
//   - Live CSV join: include/exclude membership read from the current
//     triage.csv via the same pattern as triage_prefilter.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NOTES_DIR, PROTOCOL_FILES, DATA_FILES } from '../paths.mjs';
import { readText, fileExists } from '../storage.mjs';
import { parseNoteMd } from './notes.mjs';
import { parseCsv } from './csv.mjs';
import { parseTopic } from './topic_md.mjs';
import * as vectors from './vectors.mjs';
import * as embedder from './embedder.mjs';
import * as triage from './triage.mjs';
import {
  makeMatrix,
  normalize,
  communityDetection,
  autoTuneCommunityParams,
  semanticSearch,
} from './sbert_utils.mjs';
import {
  resolveToOpenalexId,
  buildExistingIndex,
} from './snowball.mjs';

const NOTES_KIND = 'notes';
const PAPERS_KIND = 'papers';

// ---------------------------------------------------------------------------
// Theme discovery
// ---------------------------------------------------------------------------

// Cluster note embeddings to discover the natural thematic structure of
// the *included* corpus. Each community returned is a sub-theme — a set
// of papers that are tight in embedding space. The student can compare
// these against the categories they pre-declared in Setup; mismatches
// usually mean their categories are wrong (or evolving).
//
// Returns: { themes: [{ size, central_paper_id, central_title, paper_ids }], tuning, count }
export async function discoverThemes({ scope = 'include' } = {}) {
  const { ids, meta, matrix } = await vectors.loadMatrix(NOTES_KIND);
  if (matrix.rows === 0) return { themes: [], tuning: null, count: 0 };

  // Filter to whatever scope the student wants. Default 'include' — only
  // the papers they committed to are part of the corpus's thematic shape.
  // 'all' means every note (includes maybe).
  const filterSet = await loadIncludedPaperIds(scope);
  // Some notes may exist without a corresponding triage row (CLI-managed
  // corpora), so we fall through with the full set if filtering would
  // empty it out.
  const rowsToUse = [];
  const metaToUse = [];
  for (let i = 0; i < ids.length; i++) {
    const m = meta[i] || {};
    const paperId = m.paper_id || String(ids[i]);
    if (filterSet && !filterSet.has(paperId)) continue;
    rowsToUse.push(i);
    metaToUse.push({ ...m, paper_id: paperId, idx_in_matrix: i });
  }
  if (rowsToUse.length === 0) return { themes: [], tuning: null, count: 0 };

  const dim = matrix.dim;
  const flat = new Float32Array(rowsToUse.length * dim);
  for (let i = 0; i < rowsToUse.length; i++) {
    flat.set(matrix.data.subarray(rowsToUse[i] * dim, (rowsToUse[i] + 1) * dim), i * dim);
  }
  const M = makeMatrix(rowsToUse.length, dim, flat);
  const tuning = autoTuneCommunityParams(M, { minSize: 2 });
  const groups = communityDetection(M, {
    threshold: tuning.threshold,
    minCommunitySize: tuning.minCommunitySize,
  });
  groups.sort((a, b) => b.length - a.length);

  const themes = groups.map((group) => ({
    size: group.length,
    central_paper_id: metaToUse[group[0]].paper_id,
    central_title: metaToUse[group[0]].title || '',
    paper_ids: group.map((gi) => metaToUse[gi].paper_id),
    sample_titles: group.slice(0, 5).map((gi) => metaToUse[gi].title || '').filter(Boolean),
  }));

  return { themes, tuning, count: rowsToUse.length };
}

// Load the set of paper_ids the student has accepted as include
// (and optionally maybe). Used to scope synthesis-side analyses to the
// committed corpus rather than every paper that was ever embedded.
async function loadIncludedPaperIds(scope) {
  if (scope === 'all') return null; // null disables filtering
  const rows = await triage.getAll();
  const set = new Set();
  for (const r of rows) {
    if (scope === 'include' && r.triage_label === 'include' && r.paper_id) set.add(r.paper_id);
    if (scope === 'include_and_maybe' &&
        (r.triage_label === 'include' || r.triage_label === 'maybe') &&
        r.paper_id) set.add(r.paper_id);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Limitation aggregation
// ---------------------------------------------------------------------------

// Walk every note's frontmatter, pull the `limitations_authors_state` array,
// embed each admitted limitation, and community-detect the result. Each
// cluster is a recurring limitation across the corpus — directly readable
// as a gap signal: if 12 papers in your include set admit they don't
// handle long contexts, that's a real research opportunity.
//
// Returns: { clusters: [{ size, sample_limitations, paper_ids, central_text }], tuning, total_limitations }
export async function aggregateLimitations({ scope = 'include' } = {}) {
  const filterSet = await loadIncludedPaperIds(scope);
  const entries = await readAllLimitations(filterSet);
  if (entries.length === 0) {
    return { clusters: [], tuning: null, total_limitations: 0 };
  }
  // Single-shot batch embed — usually under a hundred limitations.
  const r = await embedder.embed(entries.map((e) => e.text));
  const dim = r.dim;
  const M = makeMatrix(entries.length, dim, r.data);
  const tuning = autoTuneCommunityParams(M, { minSize: 2 });
  const groups = communityDetection(M, {
    threshold: tuning.threshold,
    minCommunitySize: tuning.minCommunitySize,
  });
  groups.sort((a, b) => b.length - a.length);

  // Track which limitations didn't cluster — surface them as singletons
  // so a unique-but-important limitation isn't hidden by the clustering.
  const inCluster = new Set();
  const clusters = [];
  for (const group of groups) {
    for (const i of group) inCluster.add(i);
    const sample = group.slice(0, 5).map((i) => ({
      paper_id: entries[i].paper_id,
      text: entries[i].text,
    }));
    const paperIds = Array.from(new Set(group.map((i) => entries[i].paper_id)));
    clusters.push({
      size: group.length,
      paper_count: paperIds.length,
      central_text: entries[group[0]].text,
      sample_limitations: sample,
      paper_ids: paperIds,
    });
  }
  // Singletons appended last (smaller surface, easier to skim through).
  const singletons = [];
  for (let i = 0; i < entries.length; i++) {
    if (!inCluster.has(i)) {
      singletons.push({
        size: 1,
        paper_count: 1,
        central_text: entries[i].text,
        sample_limitations: [{ paper_id: entries[i].paper_id, text: entries[i].text }],
        paper_ids: [entries[i].paper_id],
        singleton: true,
      });
    }
  }
  return {
    clusters: clusters.concat(singletons),
    tuning,
    total_limitations: entries.length,
  };
}

async function readAllLimitations(filterSet) {
  let names;
  try { names = await fs.readdir(NOTES_DIR); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const name of names) {
    const m = name.match(/^paper_(.+)\.md$/);
    if (!m) continue;
    const paperId = m[1];
    if (filterSet && !filterSet.has(paperId)) continue;
    const md = await fs.readFile(path.join(NOTES_DIR, name), 'utf8');
    const note = parseNoteMd(md);
    const limitations = note.frontmatter?.limitations_authors_state || [];
    if (!Array.isArray(limitations)) continue;
    for (const lim of limitations) {
      const text = String(lim || '').trim();
      if (text.length < 8) continue; // skip empty stubs
      out.push({ paper_id: paperId, text });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Density-void scoring
// ---------------------------------------------------------------------------

// Embed a candidate gap statement and find how close it sits to the
// nearest existing note in the included corpus. The closer it sits, the
// less "void" it is — the gap is already covered. The further it sits,
// the more legitimate the gap (no nearby paper).
//
// Returns:
//   { void_score, nearest: { paper_id, title, similarity } | null,
//     close_neighbors: [ same-shape, top-5 closest notes ] }
//
// Interpretation hints for bge-small in tight English domains:
//   - nearest > 0.85  → effectively already covered (false-positive gap)
//   - 0.70-0.85       → adjacent work exists, gap is narrow
//   - 0.55-0.70       → real gap, some related work to position against
//   - < 0.55          → wide-open void; either a great opportunity or
//                       off-topic from the corpus
export async function scoreDensityVoid(candidateText) {
  const text = String(candidateText || '').trim();
  if (!text) {
    return { void_score: null, nearest: null, close_neighbors: [], reason: 'empty candidate' };
  }
  const r = await embedder.embed([text]);
  const queryVec = r.data; // dim-length Float32Array
  const filterSet = await loadIncludedPaperIds('include');
  const hits = await vectors.search(NOTES_KIND, queryVec, {
    topK: 5,
    filter: (id, meta) => {
      // Only include-labelled papers contribute to the corpus shape.
      if (!filterSet) return true;
      const paperId = meta?.paper_id || String(id);
      return filterSet.has(paperId);
    },
  });
  if (hits.length === 0) {
    return { void_score: 1.0, nearest: null, close_neighbors: [] };
  }
  const top = hits[0];
  return {
    void_score: 1 - top.score,
    nearest: {
      paper_id: top.meta?.paper_id || top.id,
      title: top.meta?.title || '',
      similarity: top.score,
    },
    close_neighbors: hits.map((hh) => ({
      paper_id: hh.meta?.paper_id || hh.id,
      title: hh.meta?.title || '',
      similarity: hh.score,
    })),
  };
}

// ---------------------------------------------------------------------------
// Citation-graph triangulation
// ---------------------------------------------------------------------------

// For each include-labeled paper, fetch its OpenAlex referenced_works
// (just the W-id list — cheap) and count how often each external ID
// appears across includes. References cited by many of your includes but
// missing from your corpus are the canonical "you really should have
// this" papers — the strongest gap signal we can get from the citation
// graph without external-corpus comparison.
//
// Returns: { items: [{ openalex_id, citing_count, citing_paper_ids,
//                       title, authors, year, venue, doi, arxiv_id, url }],
//           sources_total, sources_resolved }
//
// The sources_resolved < sources_total case is normal — some include
// rows have neither a DOI nor an arXiv ID and can't be resolved.
const OPENALEX_API = 'https://api.openalex.org/works';
const TRIANG_POLITE_DELAY_MS = 150;
const TRIANG_BATCH_SIZE = 50;

export async function triangulateCitations({ topK = 30, minCiting = 2 } = {}) {
  const triageRows = await loadTriagedRowsRaw();
  const includes = triageRows.filter((r) => r.triage_label === 'include');
  if (includes.length === 0) {
    return { items: [], sources_total: 0, sources_resolved: 0, reason: 'no include papers yet' };
  }

  const email = await getEmail();
  // Phase 1 — resolve each include to its OpenAlex Work ID.
  const sourceOaIds = [];
  for (const row of includes) {
    try {
      const oaId = await resolveToOpenalexId(row, { email });
      if (oaId) sourceOaIds.push({ paper_id: row.paper_id, oaId });
    } catch { /* per-paper failures don't break the whole sweep */ }
    await sleep(TRIANG_POLITE_DELAY_MS);
  }
  if (sourceOaIds.length === 0) {
    return {
      items: [], sources_total: includes.length, sources_resolved: 0,
      reason: 'could not resolve any include paper to OpenAlex',
    };
  }

  // Phase 2 — fetch each source's `referenced_works` (a list of OpenAlex
  // IDs). We only need the IDs at this stage; full Work details come later
  // for the top hits only.
  const citingByRef = new Map(); // ref_oaId -> Set of source paper_ids
  for (const src of sourceOaIds) {
    const params = new URLSearchParams();
    if (email) params.set('mailto', email);
    params.set('select', 'id,referenced_works');
    let work;
    try {
      const res = await fetch(`${OPENALEX_API}/${src.oaId}?${params}`);
      if (!res.ok) continue;
      work = await res.json();
    } catch { continue; }
    const refs = work.referenced_works || [];
    for (const rUrl of refs) {
      const m = String(rUrl).match(/(?:openalex\.org\/|^)(W\d+)/i);
      if (!m) continue;
      const rid = m[1];
      if (!citingByRef.has(rid)) citingByRef.set(rid, new Set());
      citingByRef.get(rid).add(src.paper_id);
    }
    await sleep(TRIANG_POLITE_DELAY_MS);
  }

  // Phase 3 — drop refs that point back into the include set itself, and
  // drop refs that are already in candidates_triaged (whether triaged or
  // pending). Those aren't gaps; they're already known.
  const dedupIndex = buildExistingIndex(triageRows);
  const refCounts = [];
  for (const [rid, citers] of citingByRef) {
    if (dedupIndex.oaIds.has(rid)) continue;
    if (citers.size < minCiting) continue;
    refCounts.push({ rid, count: citers.size, citers: Array.from(citers) });
  }
  refCounts.sort((a, b) => b.count - a.count);
  const topRefs = refCounts.slice(0, topK);
  if (topRefs.length === 0) {
    return {
      items: [], sources_total: includes.length, sources_resolved: sourceOaIds.length,
      reason: 'no references cited by ≥' + minCiting + ' includes that aren\'t already in your corpus',
    };
  }

  // Phase 4 — batch-fetch full Work details for just the top hits.
  const items = [];
  for (let i = 0; i < topRefs.length; i += TRIANG_BATCH_SIZE) {
    const slice = topRefs.slice(i, i + TRIANG_BATCH_SIZE);
    const params = new URLSearchParams();
    if (email) params.set('mailto', email);
    params.set('filter', `ids.openalex:${slice.map((s) => s.rid).join('|')}`);
    params.set('per_page', String(slice.length));
    try {
      const res = await fetch(`${OPENALEX_API}?${params}`);
      if (!res.ok) continue;
      const data = await res.json();
      const byId = new Map();
      for (const w of data.results || []) {
        const m = String(w.id).match(/(?:openalex\.org\/|^)(W\d+)/i);
        if (m) byId.set(m[1], w);
      }
      for (const ref of slice) {
        const w = byId.get(ref.rid);
        if (!w) continue;
        const authors = (w.authorships || []).map((a) => a?.author?.display_name).filter(Boolean);
        let doi = w.doi || '';
        if (doi.startsWith('https://doi.org/')) doi = doi.slice('https://doi.org/'.length);
        const venue = w.primary_location?.source?.display_name ||
          w.host_venue?.display_name ||
          w.locations?.[0]?.source?.display_name ||
          '';
        items.push({
          openalex_id: ref.rid,
          citing_count: ref.count,
          citing_paper_ids: ref.citers,
          title: w.title || '',
          authors: authors.join(', '),
          year: String(w.publication_year || ''),
          venue,
          doi,
          arxiv_id: extractArxivIdFromWork(w),
          url: w.id || '',
        });
      }
    } catch { /* tolerant of per-batch failures */ }
    if (i + TRIANG_BATCH_SIZE < topRefs.length) await sleep(TRIANG_POLITE_DELAY_MS);
  }

  return {
    items,
    sources_total: includes.length,
    sources_resolved: sourceOaIds.length,
  };
}

function extractArxivIdFromWork(w) {
  const a = w.ids?.arxiv || w.external_ids?.arxiv || '';
  if (!a) return '';
  return String(a).replace(/^https?:\/\/arxiv\.org\/abs\//, '');
}

async function loadTriagedRowsRaw() {
  if (!await fileExists(DATA_FILES.candidates_triaged)) return [];
  const text = await readText(DATA_FILES.candidates_triaged, '');
  const { rows } = parseCsv(text);
  return rows;
}

async function getEmail() {
  const md = await readText(PROTOCOL_FILES.topic, '');
  return parseTopic(md).contact_email || '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Outlier flag
// ---------------------------------------------------------------------------

// Surface include-labeled notes whose embeddings sit far from the include
// centroid. These are typically (a) papers the student flagged include
// but that don't fit the rest of the corpus, or (b) genuinely novel
// papers worth highlighting in the catalogue. Either way, surfacing them
// is useful: outliers are either mistakes or chapters in their own right.
//
// Returns: { items: [{ paper_id, title, distance, similarity }],
//           include_count, centroid_norm }
//
// distance = 1 - cosine(note, include_centroid). Higher = further from
// the typical include — these get sorted first.
export async function findOutliers({ topK = 10, minDistance = 0.20 } = {}) {
  const filterSet = await loadIncludedPaperIds('include');
  const { ids, meta, matrix } = await vectors.loadMatrix('notes');
  if (matrix.rows === 0) {
    return { items: [], include_count: 0, reason: 'no notes embedded yet' };
  }
  const dim = matrix.dim;
  // Filter rows to the include set, build a sub-matrix.
  const subIdx = [];
  const subMeta = [];
  for (let i = 0; i < ids.length; i++) {
    const paperId = meta[i]?.paper_id || String(ids[i]);
    if (!filterSet || !filterSet.has(paperId)) continue;
    subIdx.push(i);
    subMeta.push({ ...meta[i], paper_id: paperId });
  }
  if (subIdx.length < 2) {
    return { items: [], include_count: subIdx.length, reason: 'need at least 2 include notes to compute outliers' };
  }
  // Centroid (mean of unit-normalized vectors → renormalize).
  const centroid = new Float32Array(dim);
  for (const i of subIdx) {
    const off = i * dim;
    for (let k = 0; k < dim; k++) centroid[k] += matrix.data[off + k];
  }
  for (let k = 0; k < dim; k++) centroid[k] /= subIdx.length;
  let norm = 0;
  for (let k = 0; k < dim; k++) norm += centroid[k] * centroid[k];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let k = 0; k < dim; k++) centroid[k] /= norm;

  // Distance from each include note to the centroid.
  const scored = [];
  for (let j = 0; j < subIdx.length; j++) {
    const i = subIdx[j];
    const off = i * dim;
    let dot = 0;
    for (let k = 0; k < dim; k++) dot += matrix.data[off + k] * centroid[k];
    const distance = 1 - dot;
    if (distance < minDistance) continue;
    scored.push({
      paper_id: subMeta[j].paper_id,
      title: subMeta[j].title || '',
      distance,
      similarity: dot,
    });
  }
  scored.sort((a, b) => b.distance - a.distance);
  return {
    items: scored.slice(0, topK),
    include_count: subIdx.length,
    centroid_norm: norm,
  };
}

// ---------------------------------------------------------------------------
// Contradiction surfacing
// ---------------------------------------------------------------------------

// Find pairs of notes whose embeddings are similar (paraphraseMining) and
// surface them as candidate-contradictions. The LLM judges each pair on
// demand — we don't pre-judge because it's slow and most "similar" pairs
// turn out to agree rather than contradict. The student picks which pairs
// to dig into via a per-pair "check" button in the UI.
//
// Returns: { pairs: [{ a: noteSummary, b: noteSummary, similarity }], total_notes }
//
// We only include INCLUDE-labelled notes — contradictions in your
// committed corpus are what matter for synthesis.
export async function surfaceContradictionCandidates({ minSimilarity = 0.75, maxPairs = 30 } = {}) {
  const filterSet = await loadIncludedPaperIds('include');
  const { ids, meta, matrix } = await vectors.loadMatrix(NOTES_KIND);
  if (matrix.rows < 2) return { pairs: [], total_notes: matrix.rows };

  // Filter to include set and gather the embeddings + meta in parallel arrays.
  const subRows = [];
  const subMeta = [];
  for (let i = 0; i < ids.length; i++) {
    const paperId = meta[i]?.paper_id || String(ids[i]);
    if (filterSet && !filterSet.has(paperId)) continue;
    subRows.push(i);
    subMeta.push({ ...meta[i], paper_id: paperId, vec_idx: i });
  }
  if (subRows.length < 2) return { pairs: [], total_notes: subRows.length };

  const dim = matrix.dim;
  const flat = new Float32Array(subRows.length * dim);
  for (let i = 0; i < subRows.length; i++) {
    flat.set(matrix.data.subarray(subRows[i] * dim, (subRows[i] + 1) * dim), i * dim);
  }
  const M = makeMatrix(subRows.length, dim, flat);
  // paraphraseMining returns [score, i, j] tuples sorted descending.
  const { paraphraseMining } = await import('./sbert_utils.mjs');
  const triples = paraphraseMining(M, { topK: 10, minScore: minSimilarity, maxPairs });

  // Hydrate each pair with the note frontmatter the LLM will need to judge.
  const noteByPaperId = await readNoteFrontmatters(subMeta.map((m) => m.paper_id));
  const pairs = [];
  for (const [score, i, j] of triples) {
    const a = subMeta[i];
    const b = subMeta[j];
    if (!a || !b) continue;
    pairs.push({
      similarity: score,
      a: noteSummary(a.paper_id, a.title || '', noteByPaperId.get(a.paper_id)),
      b: noteSummary(b.paper_id, b.title || '', noteByPaperId.get(b.paper_id)),
    });
  }
  return { pairs, total_notes: subRows.length };
}

function noteSummary(paperId, title, fm) {
  return {
    paper_id: paperId,
    title: title || (fm?.title || ''),
    authors: Array.isArray(fm?.authors) ? fm.authors.slice(0, 3).join(', ') : '',
    year: fm?.year || '',
    venue: fm?.venue || '',
    primary_contribution: fm?.claims?.primary_contribution || '',
    novelty_strength: fm?.claims?.novelty_strength || '',
    method_family: fm?.method?.family || '',
    method_specific: fm?.method?.specific || '',
    stated_limitations: Array.isArray(fm?.limitations_authors_state)
      ? fm.limitations_authors_state.slice(0, 4)
      : [],
  };
}

async function readNoteFrontmatters(paperIds) {
  const map = new Map();
  for (const pid of paperIds) {
    const file = path.join(NOTES_DIR, `paper_${pid}.md`);
    try {
      const md = await fs.readFile(file, 'utf8');
      const note = parseNoteMd(md);
      map.set(pid, note.frontmatter);
    } catch {
      map.set(pid, null);
    }
  }
  return map;
}

// Build the LLM prompt used by the UI to judge a specific pair. The
// frontend calls this through llm_proxy / WebLLM, not server-side, so the
// student's chosen provider is honoured.
export function buildContradictionPrompt(pair) {
  const lim = (arr) => (arr || []).map((s) => `  - ${s}`).join('\n') || '  (none recorded)';
  return [
    'You are auditing a literature review for intellectual tensions.',
    'Read the two papers below and judge whether they CONTRADICT each other on claims, methods, or stated limitations.',
    '',
    'Paper A:',
    `Title. ${pair.a.title}`,
    `Authors. ${pair.a.authors} (${pair.a.year})`,
    `Primary contribution. ${pair.a.primary_contribution || '(unknown)'}`,
    `Method. ${pair.a.method_family} ${pair.a.method_specific ? '— ' + pair.a.method_specific : ''}`,
    `Stated limitations:`,
    lim(pair.a.stated_limitations),
    '',
    'Paper B:',
    `Title. ${pair.b.title}`,
    `Authors. ${pair.b.authors} (${pair.b.year})`,
    `Primary contribution. ${pair.b.primary_contribution || '(unknown)'}`,
    `Method. ${pair.b.method_family} ${pair.b.method_specific ? '— ' + pair.b.method_specific : ''}`,
    `Stated limitations:`,
    lim(pair.b.stated_limitations),
    '',
    'Output exactly two lines:',
    'VERDICT: contradict OR agree OR nuance OR unrelated',
    'EXPLANATION: <one sentence>',
  ].join('\n');
}

// Score many candidate texts at once (e.g. the existing gap candidates
// list from synthesis state). Returns a parallel array of density-void
// payloads, same shape as scoreDensityVoid for each entry.
export async function scoreDensityVoidsBatch(texts) {
  const cleaned = texts.map((t) => String(t || '').trim());
  if (cleaned.every((t) => !t)) {
    return cleaned.map(() => ({ void_score: null, nearest: null, close_neighbors: [] }));
  }
  // Embed only non-empty texts to save calls.
  const nonEmpty = cleaned.map((t, i) => ({ t, i })).filter(({ t }) => t.length > 0);
  const r = await embedder.embed(nonEmpty.map(({ t }) => t));
  const dim = r.dim;
  const filterSet = await loadIncludedPaperIds('include');
  const out = cleaned.map(() => ({ void_score: null, nearest: null, close_neighbors: [] }));
  for (let n = 0; n < nonEmpty.length; n++) {
    const queryVec = r.data.subarray(n * dim, (n + 1) * dim);
    // Copy because vectors.search mutates / detaches typed-array views.
    const fresh = new Float32Array(queryVec);
    const hits = await vectors.search(NOTES_KIND, fresh, {
      topK: 5,
      filter: (id, meta) => {
        if (!filterSet) return true;
        const paperId = meta?.paper_id || String(id);
        return filterSet.has(paperId);
      },
    });
    if (hits.length === 0) {
      out[nonEmpty[n].i] = { void_score: 1.0, nearest: null, close_neighbors: [] };
      continue;
    }
    const top = hits[0];
    out[nonEmpty[n].i] = {
      void_score: 1 - top.score,
      nearest: {
        paper_id: top.meta?.paper_id || top.id,
        title: top.meta?.title || '',
        similarity: top.score,
      },
      close_neighbors: hits.map((hh) => ({
        paper_id: hh.meta?.paper_id || hh.id,
        title: hh.meta?.title || '',
        similarity: hh.score,
      })),
    };
  }
  return out;
}
