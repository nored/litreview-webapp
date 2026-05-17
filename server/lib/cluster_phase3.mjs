// cluster_phase3.mjs
//
// Phase 3 orchestrator: emergent clusters with AI auto-labelling.
//
// For each "kind" (papers / claims / methods / entity_spans) we:
//   1. Load the embedding matrix from its JSONL sidecar.
//   2. Run sentence-transformers community_detection with auto-tuned
//      threshold + min_community_size. Outliers (singletons / sub-min
//      communities) get cluster_id = NULL.
//   3. For each cluster, sample 3-5 representative members closest to
//      the cluster centroid and send them to the configured AI provider
//      with a strict "name this cluster" prompt.
//   4. Persist the cluster row + its label provenance.
//   5. Update each member row's cluster_id column.
//
// The auto_label is GENERATIVE — the LLM is doing the right thing
// here per the project's per-stage AI principle. When AI is off, we
// fall back to "most distinctive bigrams from the cluster's member
// text" so the system still produces meaningful labels without an
// external dependency.

import * as store from './store.mjs';
import { callLlm, pickAvailableProvider } from './llm_proxy.mjs';
import {
  communityDetection, autoTuneCommunityParams, row as matrixRow,
} from './sbert_utils.mjs';
import { loadSidecar } from './embed_phase3.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Per-cluster representative sampling
// ─────────────────────────────────────────────────────────────────────────

// Centroid = mean of member vectors. Top-N members = those whose dot
// product with the centroid is highest (closest to "the average member
// of this cluster"). These are what the AI labeller sees.
function pickRepresentatives(matrix, memberIdxs, n = 5) {
  if (memberIdxs.length <= n) return memberIdxs.slice();
  const dim = matrix.dim;
  const centroid = new Float32Array(dim);
  for (const idx of memberIdxs) {
    const r = matrixRow(matrix, idx);
    for (let k = 0; k < dim; k++) centroid[k] += r[k];
  }
  for (let k = 0; k < dim; k++) centroid[k] /= memberIdxs.length;
  // Sort by cosine to centroid (matrix rows are L2-normalised, so dot
  // product = cosine).
  const scored = memberIdxs.map((idx) => {
    const r = matrixRow(matrix, idx);
    let s = 0;
    for (let k = 0; k < dim; k++) s += r[k] * centroid[k];
    return { idx, score: s };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((x) => x.idx);
}

// ─────────────────────────────────────────────────────────────────────────
// AI labeller — per-stage AI choice, prompts vary per kind so the label
// reads sensibly ("cache-timing attack" vs "differential cryptanalysis"
// for an entity-cluster; "high-recall information retrieval" for a
// paper-cluster).
// ─────────────────────────────────────────────────────────────────────────

const LABEL_PROMPTS = {
  paper: `You are labelling a cluster of research papers. Below are 3-5 sample papers from the cluster (title + abstract preview). Read them and produce a SHORT label (2-6 words, lowercase, hyphens if needed) that names the topical group. Examples: "side-channel cache attacks", "treaty diplomacy interwar europe", "subscription churn prediction". Output ONLY the label string. No quotes, no explanation.`,
  claim: `You are labelling a cluster of CLAIMS extracted from research papers — sentences expressing findings / contributions / limitations / etc. Below are 3-5 sample claims from one cluster. Read them and produce a SHORT label (2-6 words, lowercase) that captures the COMMON CLAIM TYPE these papers are making. Examples: "novel cache attack proposal", "limitation of single-core evaluation", "future work cross-architecture testing". Output ONLY the label string.`,
  method: `You are labelling a cluster of papers grouped by methodological similarity (their methods + experimental setup sections). Below are 3-5 sample paper-methods. Produce a SHORT label (2-6 words, lowercase) naming the methodology family. Examples: "prime-probe cache profiling", "formal-verification of constant-time", "hardware-counter monitoring". Output ONLY the label string.`,
  entity: `You are labelling a cluster of NAMED ENTITY SPANS extracted from research papers. Below are 5-15 sample spans from one cluster (verbatim, with brief context). Produce a SHORT label (1-4 words, lowercase, hyphens if needed) that names the entity TYPE — what these spans have in common. Examples: "cpu-architecture", "cache-attack-technique", "cryptographic-primitive", "research-institution". Output ONLY the label string.`,
};

async function labelCluster(kind, samples, provider) {
  const prompt = LABEL_PROMPTS[kind];
  if (!prompt) throw new Error(`labelCluster: unknown kind ${kind}`);
  // samples: array of strings (representative member text).
  const body = samples.map((s, i) => `[${i + 1}] ${String(s).slice(0, 600).replace(/\s+/g, ' ').trim()}`).join('\n\n');
  if (!provider) {
    // Local fallback: most-frequent capitalised bigram / acronym across
    // the sample. Coarse but works without any AI.
    return { label: localBigramLabel(samples), mechanism: 'local_bigram', model: null };
  }
  let raw;
  try {
    raw = await callLlm({
      provider,
      system: 'You return a single short label string. No prose, no quotes, no markdown.',
      user: prompt + '\n\nSAMPLES:\n' + body,
      temperature: 0,
    });
  } catch (e) {
    return { label: localBigramLabel(samples), mechanism: 'local_bigram_after_llm_error', model: null, error: e.message };
  }
  // Normalise: strip surrounding punctuation/quotes, collapse whitespace,
  // trim to 80 chars. Fall back to bigram if empty.
  let label = String(raw || '').trim()
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  if (!label) label = localBigramLabel(samples);
  return { label, mechanism: 'llm_finder', model: provider, raw };
}

function localBigramLabel(samples) {
  const STOP = new Set(['the','a','an','and','or','but','of','for','to','from','in','on','at','by','with','as','is','are','was','were','be','been','this','that','these','those','it','its','our','their','we','they']);
  const counts = new Map();
  for (const s of samples) {
    const words = String(s).toLowerCase().replace(/[^a-z0-9\- ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w) && w.length > 2);
    for (let i = 0; i < words.length - 1; i++) {
      const bg = `${words[i]} ${words[i+1]}`;
      counts.set(bg, (counts.get(bg) || 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] || 'unlabelled';
}

// ─────────────────────────────────────────────────────────────────────────
// Cluster + persist per kind
// ─────────────────────────────────────────────────────────────────────────

const CONFIG = {
  paper: {
    sidecar: 'papers',
    clusterTable: 'paper_clusters',
    memberTable: 'papers',
    memberKey: 'paper_id',
    memberClusterCol: 'paper_cluster_id',
    sampleText: (m) => `${m.content_preview || ''}`,
    minSize: 2,
    nSamples: 5,
    maxAutoMinSize: 20,   // papers: expect a handful of broad clusters
  },
  claim: {
    sidecar: 'claims',
    clusterTable: 'claim_clusters',
    memberTable: 'claims',
    memberKey: 'claim_id',
    memberClusterCol: 'cluster_id',
    sampleText: (m) => m.text || m.content_preview || '',
    minSize: 2,
    nSamples: 5,
    maxAutoMinSize: 5,    // claims: many small thematic clusters expected
  },
  method: {
    sidecar: 'methods',
    clusterTable: 'method_clusters',
    memberTable: 'papers',
    memberKey: 'paper_id',
    memberClusterCol: 'method_cluster_id',
    sampleText: (m) => m.content_preview || '',
    minSize: 2,
    nSamples: 5,
    maxAutoMinSize: 10,
  },
  entity: {
    sidecar: 'entity_contexts',
    clusterTable: 'entity_clusters',
    memberTable: 'entity_spans',
    memberKey: 'entity_span_id',
    memberClusterCol: 'cluster_id',
    sampleText: (m) => `${m.span_text || ''} (context: ${(m.content_preview || '').slice(0, 100)})`,
    minSize: 2,
    nSamples: 8,
    maxAutoMinSize: 5,    // entities: highly granular; cap aggressively
  },
};

// For the claim sidecar we need to load from the existing claims.jsonl
// path which lives under _vectors/claims.jsonl. Wire that to loadSidecar
// by adding a synonym.
async function loadKindSidecar(kind) {
  if (kind === 'claim') {
    // The existing claims.jsonl format has slightly different keys
    // (claim_id, paper_id, claim_type, embedding). Load it via the same
    // helper but the sidecar name in embed_phase3 is 'claims'? It's not
    // there. Manually load it.
    const path = await import('node:path');
    const { promises: fs } = await import('node:fs');
    const { DATA_DIR } = await import('../paths.mjs');
    const p = path.join(DATA_DIR, '_vectors', 'claims.jsonl');
    let txt;
    try { txt = await fs.readFile(p, 'utf8'); } catch { return null; }
    const records = [];
    for (const line of txt.split('\n')) {
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch { /* skip */ }
    }
    if (records.length === 0) return null;
    const dim = records[0].embedding?.length || 0;
    if (dim === 0) return null;
    // Join claim text from SQLite — claims.jsonl only has claim_id +
    // claim_type. We need the text for sampling.
    const claimIds = records.map((r) => r.claim_id);
    const placeholders = claimIds.map(() => '?').join(',');
    const texts = store.query(
      `SELECT claim_id, text, paper_id, claim_type, stance FROM claims WHERE claim_id IN (${placeholders})`,
      claimIds,
    );
    const textByClaim = new Map(texts.map((t) => [t.claim_id, t]));
    const data = new Float32Array(records.length * dim);
    const meta = [];
    let kept = 0;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const dbRow = textByClaim.get(r.claim_id);
      if (!dbRow) continue;     // claim was deleted; skip
      data.set(r.embedding, kept * dim);
      meta.push({
        claim_id: r.claim_id,
        paper_id: r.paper_id,
        claim_type: dbRow.claim_type,
        stance: dbRow.stance,
        text: dbRow.text,
      });
      kept++;
    }
    if (kept === 0) return null;
    return { matrix: { data: data.subarray(0, kept * dim), rows: kept, dim }, meta };
  }
  return loadSidecar(CONFIG[kind].sidecar);
}

/**
 * Run clustering for one kind. Wipes existing cluster rows + member
 * cluster_id columns for that kind before writing fresh ones.
 */
async function clusterKind(kind, provider, opts = {}) {
  const cfg = CONFIG[kind];
  if (!cfg) throw new Error(`unknown cluster kind: ${kind}`);
  const sidecar = await loadKindSidecar(kind);
  if (!sidecar) {
    return { kind, error: 'no_embeddings', hint: 'run generatePhase3Embeddings first' };
  }
  const { matrix, meta } = sidecar;
  if (matrix.rows < (cfg.minSize ?? 2)) {
    return { kind, error: 'too_few_members', n: matrix.rows };
  }
  // Auto-tune communityDetection params for this matrix. The auto-tuned
  // minCommunitySize uses n/5 which is right for paper-level clustering
  // but wildly wrong for entity-span clustering (we expect MANY small
  // type-clusters, not n/5-sized ones). Cap per kind.
  const tuned = autoTuneCommunityParams(matrix, {});
  const threshold = opts.threshold ?? tuned.threshold ?? 0.65;
  const cappedMin = Math.min(tuned.minCommunitySize ?? cfg.minSize, cfg.maxAutoMinSize ?? Infinity);
  const minSize = opts.minSize ?? Math.max(cfg.minSize, cappedMin);
  const clusters = communityDetection(matrix, { threshold, minCommunitySize: minSize });
  if (!Array.isArray(clusters)) {
    return { kind, error: 'community_detection_returned_invalid' };
  }
  // Wipe prior cluster rows + member cluster_id assignments.
  store.exec(`DELETE FROM ${cfg.clusterTable}`);
  // Reset member cluster_id column to NULL.
  store.exec(`UPDATE ${cfg.memberTable} SET ${cfg.memberClusterCol} = NULL`);

  // For each cluster: pick reps, label, write cluster row, write member assignments.
  let labelledCount = 0;
  const summary = [];
  for (const cluster of clusters) {
    if (!Array.isArray(cluster) || cluster.length < minSize) continue;
    const repIdxs = pickRepresentatives(matrix, cluster, cfg.nSamples ?? 5);
    const samples = repIdxs.map((i) => cfg.sampleText(meta[i]));
    const labelResult = await labelCluster(kind, samples, provider);

    // Stance + claim_type distribution for claim clusters.
    let stanceDistJson = null;
    let claimTypeDistJson = null;
    if (kind === 'claim') {
      const stanceCount = {};
      const typeCount = {};
      for (const i of cluster) {
        const m = meta[i];
        if (m.stance) stanceCount[m.stance] = (stanceCount[m.stance] || 0) + 1;
        if (m.claim_type) typeCount[m.claim_type] = (typeCount[m.claim_type] || 0) + 1;
      }
      stanceDistJson = JSON.stringify(stanceCount);
      claimTypeDistJson = JSON.stringify(typeCount);
    }
    let glinerLabelDistJson = null;
    if (kind === 'entity') {
      const dist = {};
      // We need to join meta entities back to the entity_spans table for
      // their gliner_label. Pull labels by id.
      const ids = cluster.map((i) => meta[i].entity_span_id).filter(Boolean);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const rows = store.query(
          `SELECT gliner_label, COUNT(*) AS n FROM entity_spans WHERE entity_span_id IN (${placeholders}) GROUP BY gliner_label`,
          ids,
        );
        for (const r of rows) dist[r.gliner_label || '(none)'] = r.n;
      }
      glinerLabelDistJson = JSON.stringify(dist);
    }

    const provId = store.recordProvenance({
      mechanism: labelResult.mechanism,
      model: labelResult.model,
      raw_text: labelResult.raw || null,
      classifier_scores: { samples_shown: samples.slice(0, 5) },
      confidence: 1.0,
      llm_response: labelResult.raw || null,
    });

    let insertSql;
    let insertArgs;
    if (kind === 'paper' || kind === 'method') {
      insertSql = `INSERT INTO ${cfg.clusterTable} (auto_label, member_count, centroid_sample_json, label_provenance_id) VALUES (?, ?, ?, ?)`;
      insertArgs = [labelResult.label, cluster.length, JSON.stringify(samples.slice(0, 5)), provId];
    } else if (kind === 'claim') {
      insertSql = `INSERT INTO ${cfg.clusterTable} (auto_label, member_count, stance_distribution_json, claim_type_distribution_json, centroid_sample_json, label_provenance_id) VALUES (?, ?, ?, ?, ?, ?)`;
      insertArgs = [labelResult.label, cluster.length, stanceDistJson, claimTypeDistJson, JSON.stringify(samples.slice(0, 5)), provId];
    } else {
      insertSql = `INSERT INTO ${cfg.clusterTable} (auto_label, member_count, gliner_label_distribution_json, centroid_sample_json, label_provenance_id) VALUES (?, ?, ?, ?, ?)`;
      insertArgs = [labelResult.label, cluster.length, glinerLabelDistJson, JSON.stringify(samples.slice(0, 5)), provId];
    }
    const { lastInsertId: clusterId } = store.exec(insertSql, insertArgs);

    // Write member assignments. We dedupe paper_ids for the paper /
    // method kinds because the sidecar is keyed paper_id and the
    // member table is also paper_id.
    if (cfg.memberKey === 'paper_id') {
      const paperIds = new Set();
      for (const i of cluster) paperIds.add(meta[i].paper_id);
      for (const pid of paperIds) {
        store.exec(`UPDATE ${cfg.memberTable} SET ${cfg.memberClusterCol} = ? WHERE ${cfg.memberKey} = ?`, [clusterId, pid]);
      }
    } else {
      for (const i of cluster) {
        const id = meta[i][cfg.memberKey];
        if (id == null) continue;
        store.exec(`UPDATE ${cfg.memberTable} SET ${cfg.memberClusterCol} = ? WHERE ${cfg.memberKey} = ?`, [clusterId, id]);
      }
    }
    labelledCount++;
    summary.push({ cluster_id: clusterId, label: labelResult.label, size: cluster.length, mechanism: labelResult.mechanism });
  }
  return {
    kind,
    n_members: matrix.rows,
    n_clusters: labelledCount,
    threshold,
    min_size: minSize,
    label_provider: provider || 'local_bigram',
    summary: summary.slice(0, 50),
  };
}

/**
 * Run clustering across all four kinds. Returns a report per kind.
 */
export async function runPhase3Clustering(opts = {}) {
  await store.init();
  const startMs = Date.now();
  const requested = opts.provider || 'auto';
  let provider;
  if (requested === 'auto') provider = await pickAvailableProvider({});
  else if (requested === 'off' || requested === 'webllm' || requested === 'share-to-chat') provider = null;
  else provider = requested;

  const report = {
    started_at: new Date().toISOString(),
    provider: provider || 'local_bigram',
    kinds: {},
  };
  for (const kind of ['paper', 'method', 'claim', 'entity']) {
    if (Array.isArray(opts.only) && !opts.only.includes(kind)) continue;
    try {
      report.kinds[kind] = await clusterKind(kind, provider, opts);
    } catch (e) {
      report.kinds[kind] = { kind, error: e.message };
    }
  }
  await store.flush();
  report.elapsed_ms = Date.now() - startMs;
  report.finished_at = new Date().toISOString();
  return report;
}

export { CONFIG as CLUSTER_KINDS };
