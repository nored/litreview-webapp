// external_comparison.mjs
//
// Phase 6.d: external-corpus comparison. Pulls a same-topic sample
// from OpenAlex, embeds them alongside the student's corpus, runs
// community_detection over the joint pool, and identifies clusters
// that are dense in the external corpus but sparse (or empty) in
// the student's corpus. Those are the "areas the field has explored
// that you haven't" — a different gap signal from the in-corpus
// detectors.
//
// Local-only after the OpenAlex fetch: every downstream step runs
// through the existing embedder + sbert_utils.
//
// Pragmatic scope:
//   * Pull up to 100 same-topic OpenAlex works (bounded, fast).
//   * Embed title+abstract of each.
//   * Embed each in-corpus paper the same way.
//   * Joint community detection over the combined matrix.
//   * For each cluster: count external vs in-corpus members; flag
//     clusters where external_count ≥ 3 and in_corpus_count ≤ 1.
//
// More sophisticated approaches (UMAP visualisation, year-by-cluster
// trends, citation-network alignment) can extend this once the basic
// signal is in the UI.

import * as store from './store.mjs';
import * as embedder from './embedder.mjs';
import { makeMatrix, normalize, communityDetection, autoTuneCommunityParams } from './sbert_utils.mjs';
import { searchOpenalex } from './search.mjs';
import { read as readCredentials } from './credentials.mjs';
import { readText } from '../storage.mjs';
import { PROTOCOL_FILES } from '../paths.mjs';
import { parseTopic } from './topic_md.mjs';

const DEFAULT_FETCH_LIMIT = 100;
const DEFAULT_TOPIC_QUERY_LIMIT = 3;       // how many queries we issue
const DEFAULT_MIN_EXTERNAL = 3;
const DEFAULT_MAX_IN_CORPUS = 1;

async function loadTopicQueries() {
  const md = await readText(PROTOCOL_FILES.topic, '');
  const t = parseTopic(md) || {};
  const queries = [];
  if (t.title) queries.push(t.title);
  // First sentence of description is usually the most concrete.
  if (t.description) {
    const firstSentence = String(t.description).split(/[.!?]\s+/)[0];
    if (firstSentence && firstSentence.length > 12) queries.push(firstSentence);
  }
  if (Array.isArray(t.categories)) {
    for (const c of t.categories.slice(0, 5)) {
      if (c && c !== 'other' && (t.title || '').toLowerCase() !== c.toLowerCase()) queries.push(c.replace(/_/g, ' '));
    }
  }
  return queries.slice(0, DEFAULT_TOPIC_QUERY_LIMIT);
}

async function fetchExternalSample(queries, opts) {
  const fetchLimit = opts.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const perQuery = Math.max(20, Math.ceil(fetchLimit / queries.length));
  const creds = await readCredentials();
  const email = creds.contact_email || 'litreview@example.com';
  const seen = new Map();
  for (const q of queries) {
    let rows = [];
    try {
      rows = await searchOpenalex(q, email, { maxResults: perQuery });
    } catch (e) {
      console.warn('external_comparison: OpenAlex query failed for', q, e?.message || e);
    }
    for (const r of rows) {
      const key = (r.doi || r.url || r.title || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      // Skip works that are already in the student's corpus.
      seen.set(key, r);
    }
    if (seen.size >= fetchLimit) break;
  }
  return [...seen.values()].slice(0, fetchLimit);
}

function inCorpusKeys(rows) {
  const dois = new Set();
  const arxivIds = new Set();
  const titles = new Set();
  for (const r of rows) {
    if (r.doi) dois.add(String(r.doi).toLowerCase());
    if (r.arxiv_id) arxivIds.add(String(r.arxiv_id).toLowerCase());
    if (r.title) titles.add(String(r.title).toLowerCase().slice(0, 80));
  }
  return { dois, arxivIds, titles };
}

function isInCorpus(externalRow, keys) {
  if (externalRow.doi && keys.dois.has(String(externalRow.doi).toLowerCase())) return true;
  if (externalRow.arxiv_id && keys.arxivIds.has(String(externalRow.arxiv_id).toLowerCase())) return true;
  if (externalRow.title && keys.titles.has(String(externalRow.title).toLowerCase().slice(0, 80))) return true;
  return false;
}

/**
 * Run the comparison. Returns
 *   {
 *     params: { fetch_limit, queries_used, in_corpus_total, external_total },
 *     clusters: [...],
 *     gap_clusters: [
 *       { id, external_count, in_corpus_count, sample_titles, sample_dois },
 *       ...
 *     ],
 *   }
 */
export async function runExternalComparison(opts = {}) {
  await store.init();
  const fetchLimit = opts.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const minExternal = opts.minExternal ?? DEFAULT_MIN_EXTERNAL;
  const maxInCorpus = opts.maxInCorpus ?? DEFAULT_MAX_IN_CORPUS;

  // 1. Queries: caller override > topic.md derived.
  let queries;
  if (Array.isArray(opts.queries) && opts.queries.length) {
    queries = opts.queries.map((q) => String(q).trim()).filter((q) => q.length > 2);
  } else {
    queries = await loadTopicQueries();
  }
  if (queries.length === 0) {
    return { error: 'no queries — pass queries:[...] in the request body or fill in topic.md first' };
  }

  // 2. Pull in-corpus papers + their identifying keys.
  const corpus = store.query(
    `SELECT paper_id, title, abstract, doi, arxiv_id, year
       FROM papers
       WHERE title IS NOT NULL AND title <> ''`,
  );
  const keys = inCorpusKeys(corpus);
  if (corpus.length === 0) {
    return { error: 'no papers in v2 store — sync from triage first' };
  }

  // 3. Fetch external sample, drop dups against in-corpus.
  const externalRaw = await fetchExternalSample(queries, { fetchLimit });
  const external = externalRaw.filter((r) => !isInCorpus(r, keys));
  if (external.length === 0) {
    return {
      params: { fetch_limit: fetchLimit, queries_used: queries, in_corpus_total: corpus.length, external_total: 0 },
      clusters: [], gap_clusters: [],
      note: 'every OpenAlex result is already in your corpus — your search is well-anchored',
    };
  }

  // 4. Embed everything in one batch. Concatenate title + abstract
  // (first 600 chars of abstract is plenty for cluster signal).
  const corpusTexts = corpus.map((r) => textFor(r));
  const externalTexts = external.map((r) => textFor(r));
  const allTexts = [...corpusTexts, ...externalTexts];
  const emb = await embedder.embed(allTexts);
  const matrix = makeMatrix(allTexts.length, emb.dim, new Float32Array(emb.data));
  normalize(matrix);

  // 5. Joint community detection.
  const tuned = autoTuneCommunityParams(matrix, { minSize: 3 });
  const communities = communityDetection(matrix, {
    threshold: opts.threshold ?? tuned.threshold,
    minCommunitySize: opts.minCommunitySize ?? tuned.minCommunitySize,
  });

  const inCorpusCount = corpus.length;
  const clusters = [];
  const gapClusters = [];
  for (let ci = 0; ci < communities.length; ci++) {
    const community = communities[ci];
    const sourceMembers = community.map((idx) => ({
      idx,
      kind: idx < inCorpusCount ? 'corpus' : 'external',
      item: idx < inCorpusCount ? corpus[idx] : external[idx - inCorpusCount],
    }));
    const corpusMembers = sourceMembers.filter((m) => m.kind === 'corpus');
    const externalMembers = sourceMembers.filter((m) => m.kind === 'external');
    const entry = {
      id: ci + 1,
      size: community.length,
      external_count: externalMembers.length,
      in_corpus_count: corpusMembers.length,
      sample_corpus: corpusMembers.slice(0, 3).map((m) => ({ paper_id: m.item.paper_id, title: m.item.title })),
      sample_external: externalMembers.slice(0, 3).map((m) => ({ title: m.item.title, doi: m.item.doi, year: m.item.year })),
    };
    clusters.push(entry);
    if (externalMembers.length >= minExternal && corpusMembers.length <= maxInCorpus) {
      gapClusters.push(entry);
    }
  }
  gapClusters.sort((a, b) => b.external_count - a.external_count);

  return {
    params: {
      fetch_limit: fetchLimit,
      queries_used: queries,
      in_corpus_total: corpus.length,
      external_total: external.length,
      community_threshold: opts.threshold ?? tuned.threshold,
      community_min_size: opts.minCommunitySize ?? tuned.minCommunitySize,
    },
    clusters,
    gap_clusters: gapClusters,
  };
}

function textFor(row) {
  const title = String(row.title || '').trim();
  const abstract = String(row.abstract || '').slice(0, 600).trim();
  if (abstract) return `${title}\n\n${abstract}`;
  return title;
}
