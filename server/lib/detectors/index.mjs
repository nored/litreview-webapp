// detectors/index.mjs
//
// Orchestrator + barrel for the Stage 2 gap detectors. Each detector is
// a pure-SQL (+ light JS) function over the structured store; this file
// runs them all and returns a combined ranked candidate set.
//
// Detectors currently implemented:
//
//   methodological_gap  (type 4) — empty (category × method) cells with
//                                   substantial row marginals
//   knowledge_gap       (type 2) — empty (category × method × domain)
//                                   cells with dense Hamming-1 neighbours
//   population_gap      (type 7) — sparse population sub-tensor cells
//   evidence_gap        (type 1) — high variance on shared (metric, dataset)
//
// Pending (require claim-cluster analysis over the embeddings sidecar):
//
//   empirical_gap       (type 5) — theorises-without-validates ratio
//   practical_gap       (type 3) — survey vs experimental claim mismatch
//   theoretical_gap     (type 6) — orphan / disputed framework clusters
//
// Pending (require citation graph + per-edge context):
//
//   citation_centrality           PageRank-style over `citations`
//   main_path_analysis            most-traversed citation chain
//   co_citation / bibliographic_coupling
//   citation_context_classification (NLI per edge)
//
// Public API:
//
//   detectAll(opts)               — runs all available detectors, returns
//                                   { byType: {...}, combined: [...] }
//   detectOne(type, opts)         — runs a single detector by type id
//
// Every detector output uses the same candidate shape:
//
//   { cell: {...}, statistic: {...}, contributing_papers: [...],
//     description: '...', salience: <number>, type: 'methodological' | ... }

import * as store from '../store.mjs';
import { detectMethodologicalGap, TYPE as METHODOLOGICAL } from './methodological_gap.mjs';
import { detectKnowledgeGap,       TYPE as KNOWLEDGE        } from './knowledge_gap.mjs';
import { detectPopulationGap,      TYPE as POPULATION       } from './population_gap.mjs';
import { detectEvidenceGap,        TYPE as EVIDENCE         } from './evidence_gap.mjs';
import { detectEmpiricalGap,         TYPE as EMPIRICAL        } from './empirical_gap.mjs';
import { detectPracticalGap,         TYPE as PRACTICAL        } from './practical_gap.mjs';
import { detectTheoreticalGap,       TYPE as THEORETICAL      } from './theoretical_gap.mjs';
import { detectCitationCentrality,   TYPE as CENTRALITY       } from './citation_centrality.mjs';
import { detectMainPath,             TYPE as MAIN_PATH        } from './main_path.mjs';
import { detectCoCitation,           TYPE as CO_CITATION      } from './co_citation.mjs';
import { detectBibliographicCoupling, TYPE as BIB_COUPLING    } from './bibliographic_coupling.mjs';
import { detectTemporalTrends,        TYPE as TEMPORAL         } from './temporal_trends.mjs';
import { detectLofNovelty,            TYPE as LOF_NOVELTY      } from './lof_novelty.mjs';
import { detectNgramNovelty,          TYPE as NGRAM_NOVELTY    } from './ngram_novelty.mjs';
import { rerankByCitations }          from './rerank.mjs';
import { buildClusters } from './_claim_clusters.mjs';

const DETECTORS = {
  [METHODOLOGICAL]: detectMethodologicalGap,
  [KNOWLEDGE]:      detectKnowledgeGap,
  [POPULATION]:     detectPopulationGap,
  [EVIDENCE]:       detectEvidenceGap,
  [EMPIRICAL]:      detectEmpiricalGap,
  [PRACTICAL]:      detectPracticalGap,
  [THEORETICAL]:    detectTheoreticalGap,
  [CENTRALITY]:     detectCitationCentrality,
  [MAIN_PATH]:      detectMainPath,
  [CO_CITATION]:    detectCoCitation,
  [BIB_COUPLING]:   detectBibliographicCoupling,
  [TEMPORAL]:       detectTemporalTrends,
  [LOF_NOVELTY]:    detectLofNovelty,
  [NGRAM_NOVELTY]:  detectNgramNovelty,
};

// Tag detectors by analytical layer so callers / UI can group output.
export const DETECTOR_CATEGORY = {
  [METHODOLOGICAL]: 'gap',
  [KNOWLEDGE]:      'gap',
  [POPULATION]:     'gap',
  [EVIDENCE]:       'gap',
  [EMPIRICAL]:      'gap',
  [PRACTICAL]:      'gap',
  [THEORETICAL]:    'gap',
  [CENTRALITY]:     'network',
  [MAIN_PATH]:      'network',
  [CO_CITATION]:    'network',
  [BIB_COUPLING]:   'network',
  [TEMPORAL]:       'temporal',
  [LOF_NOVELTY]:    'novelty',
  [NGRAM_NOVELTY]:  'novelty',
};

// Detectors that consume the shared claim-cluster index. The orchestrator
// builds it once and passes via opts to save the duplicate cost.
const CLUSTER_DETECTORS = new Set([EMPIRICAL, PRACTICAL]);

export const GAP_TYPES = Object.keys(DETECTORS);

/**
 * Run a single detector by type id. Returns the detector's own shape
 * with each candidate tagged with `type` for downstream uniformity.
 */
// Corpus-level counts used by every precondition check. Computed in a
// single round-trip and reused across all detectors in a detectAll call
// (previously this was ~30 separate COUNT queries).
function corpusCounts() {
  const r = store.query(`
    SELECT
      (SELECT COUNT(*) FROM papers WHERE triage_label IN ('include','maybe'))  AS corpus_size,
      (SELECT COUNT(*) FROM paper_field)                                        AS fields_n,
      (SELECT COUNT(*) FROM results)                                            AS results_n,
      (SELECT COUNT(*) FROM claims)                                             AS claims_n,
      (SELECT COUNT(*) FROM claims WHERE stance IS NOT NULL)                    AS stanced_n,
      (SELECT COUNT(*) FROM citations)                                          AS citations_n
  `);
  return r[0] || { corpus_size: 0, fields_n: 0, results_n: 0, claims_n: 0, stanced_n: 0, citations_n: 0 };
}

// Pure precondition check over a counts snapshot. Returns a list of
// human-readable issues (empty = ready).
function preconditionsFor(type, counts) {
  const issues = [];
  if (counts.corpus_size === 0) {
    return ['no include/maybe papers in v2 store — run /api/v2/sync first'];
  }
  if (['methodological', 'knowledge', 'population', 'practical', 'theoretical'].includes(type)
      && counts.fields_n === 0) {
    issues.push('no paper_field rows — run /api/v2/extract/corpus to populate structured fields');
  }
  if (type === 'evidence' && counts.results_n === 0) {
    issues.push('no results rows — run numerical extraction first');
  }
  if (['empirical', 'practical'].includes(type)) {
    if (counts.claims_n === 0) {
      issues.push('no claims extracted — run WebLLM claims extraction (Stage 4 → "Extract claims") first');
    }
    if (type === 'empirical' && counts.claims_n > 0 && counts.stanced_n === 0) {
      issues.push('claims exist but none have stance assigned — re-run extraction so NLI stance-classifies each claim');
    }
  }
  if (['citation_centrality', 'main_path', 'co_citation', 'bibliographic_coupling'].includes(type)
      && counts.citations_n === 0) {
    issues.push('citations table empty — run /api/v2/sync after snowballing to populate citation edges');
  }
  return issues;
}

// Deterministic per-candidate signature so the user can dismiss a
// specific candidate and have the dismissal stick across detect runs.
// Each detector emits a different candidate shape; we pick the most
// stable identifying fields available.
//
// Cluster-based candidates (empirical / practical / knowledge gap)
// embed a non-deterministic cluster_id from community_detection. We
// strip that and use the top-3 contributing paper IDs (sorted) instead,
// so a cluster's signature is stable across runs even when membership
// drifts a little — the user dismissed "this gap involving papers A,
// B, C" and the same gap re-detected with one extra member D should
// stay dismissed.
export function signatureFor(type, candidate) {
  if (!candidate) return '';

  // Cluster-based cell: cluster_id is run-specific, papers are stable.
  if (candidate.cell && typeof candidate.cell === 'object' && 'cluster_id' in candidate.cell) {
    const papers = extractPaperList(candidate.contributing_papers);
    if (papers.length > 0) {
      // Top-3 sorted paper IDs as the cluster's stable fingerprint.
      const top3 = [...papers].sort().slice(0, 3).join(',');
      return `${type}:cluster:${top3}`;
    }
    // Last resort if no contributing papers: description hash.
    return `${type}:cluster:${(candidate.description || '').slice(0, 80)}`;
  }

  // Cell-based detectors (methodological / knowledge / population /
  // theoretical / evidence) embed a structured `cell` object.
  if (candidate.cell && typeof candidate.cell === 'object') {
    const keys = Object.keys(candidate.cell).sort();
    return `${type}:` + keys.map((k) => `${k}=${candidate.cell[k] ?? ''}`).join('|');
  }
  // Network detectors emit pairs.
  if (candidate.paper_a && candidate.paper_b) {
    return `${type}:` + [candidate.paper_a, candidate.paper_b].sort().join('::');
  }
  // Single-paper candidates (centrality, novelty).
  if (candidate.paper_id) return `${type}:paper:${candidate.paper_id}`;
  // Plain contributing_papers (no cluster_id wrapper).
  if (Array.isArray(candidate.contributing_papers) && candidate.contributing_papers.length) {
    return `${type}:papers:` + [...candidate.contributing_papers].sort().slice(0, 3).join(',');
  }
  // Temporal trends emit an axis + axis_value.
  if (candidate.axis && candidate.axis_value) {
    return `${type}:${candidate.axis}=${candidate.axis_value}`;
  }
  // Last resort: stringify a stable subset of fields.
  return `${type}:` + JSON.stringify({ d: (candidate.description || '').slice(0, 60), s: candidate.subtype || '' });
}

// Some detectors emit contributing_papers as { theorising, validating }
// or other nested shapes. Flatten to a flat string array.
function extractPaperList(field) {
  if (!field) return [];
  if (Array.isArray(field)) return field.map(String).filter(Boolean);
  if (typeof field === 'object') {
    const out = [];
    for (const v of Object.values(field)) {
      if (Array.isArray(v)) for (const id of v) if (id) out.push(String(id));
    }
    return out;
  }
  return [];
}

function loadDismissals(type) {
  const rows = store.query(
    `SELECT signature FROM dismissed_candidates WHERE detector_type = ?`,
    [type],
  );
  return new Set(rows.map((r) => r.signature));
}

function annotateAndFilter(type, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates;
  const dismissed = loadDismissals(type);
  const out = [];
  for (const c of candidates) {
    const sig = signatureFor(type, c);
    c.signature = sig;
    if (sig && dismissed.has(sig)) continue;
    out.push(c);
  }
  return out;
}

export async function detectOne(type, opts = {}) {
  await store.init();
  const fn = DETECTORS[type];
  if (!fn) throw new Error(`detectOne: unknown gap type "${type}"`);
  const counts = opts._counts || corpusCounts();
  const preconditionIssues = preconditionsFor(type, counts);
  const result = await fn(opts);
  if (Array.isArray(result?.candidates)) {
    for (const c of result.candidates) c.type = type;
    const before = result.candidates.length;
    result.candidates = annotateAndFilter(type, result.candidates);
    result.dismissed_count = before - result.candidates.length;
  }
  return {
    type,
    preconditions: preconditionIssues,
    preconditions_ok: preconditionIssues.length === 0,
    ...result,
  };
}

/**
 * Run all available detectors in parallel. Returns:
 *   {
 *     byType: { methodological: {...}, knowledge: {...}, ... },
 *     combined: [...],          // all candidates, re-ranked across types
 *     summary: { total, per_type: {...} }
 *   }
 *
 * Cross-type ranking uses each candidate's `salience` field directly —
 * the per-detector salience formulas are roughly comparable in scale
 * but tuning may shift if some detectors over-dominate.
 *
 * opts:
 *   only           — array of type ids to run; default all
 *   topK           — cap on combined list (default 100)
 *   detectorOpts   — passed through to each detector
 */
export async function detectAll(opts = {}) {
  await store.init();
  // Recompute corpus-size-adaptive thresholds at the start of every call;
  // the cached value would otherwise be stale across ingest cycles.
  const { clearCache: clearThresholdCache, pickThresholds: pickT } = await import('./_scale.mjs');
  clearThresholdCache();
  const thresholds = pickT();
  const which = Array.isArray(opts.only) && opts.only.length
    ? opts.only.filter((t) => t in DETECTORS)
    : GAP_TYPES;
  const topK = opts.topK ?? 100;
  const detectorOpts = opts.detectorOpts ?? {};

  // Build the shared claim-cluster index once if any of the requested
  // detectors needs it. Avoids re-running community_detection N times.
  const needsClusters = which.some((t) => CLUSTER_DETECTORS.has(t));
  const clusters = needsClusters
    ? await buildClusters(detectorOpts.clusterOpts || {})
    : null;

  // Compute corpus-level counts ONCE and share across every detector's
  // precondition check (previously this was ~30 round-trips per call).
  const counts = corpusCounts();

  // Run detectors in parallel. Each is pure SQL/JS; mutual exclusion via
  // sql.js's single-threaded model isn't a concern.
  const results = await Promise.all(which.map((type) => {
    const optsForOne = { ...detectorOpts, _counts: counts };
    if (CLUSTER_DETECTORS.has(type) && clusters) optsForOne.clusters = clusters;
    return detectOne(type, optsForOne);
  }));

  const byType = {};
  let combined = [];
  const perType = {};
  const preconditionWarnings = [];
  for (const r of results) {
    byType[r.type] = r;
    perType[r.type] = (r.candidates || []).length;
    for (const c of (r.candidates || [])) combined.push(c);
    if (r.preconditions?.length) {
      preconditionWarnings.push({ type: r.type, issues: r.preconditions });
    }
  }

  // Optional citation-weighted reranking on the combined cross-type list.
  // Applied after per-type sorting so each candidate's `rerank.multiplier`
  // is comparable across types.
  const citationsN = store.query('SELECT COUNT(*) AS n FROM citations')[0]?.n || 0;
  let rerankNote = null;
  if (opts.rerankByCitations) {
    if (citationsN === 0) {
      rerankNote = 'rerank skipped: citations table is empty (all candidates weighted equally). Run /api/v2/sync after snowballing.';
      combined.sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
    } else {
      combined = await rerankByCitations(combined);
    }
  } else {
    combined.sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
  }

  // Stale-detection check: if extractions happened since the last
  // detect run, the dashboard the user is looking at may be out of date.
  const lastExtracted = store.query(
    `SELECT value FROM schema_meta WHERE key = 'last_extracted_at'`,
  )[0]?.value || null;
  const lastDetected = store.query(
    `SELECT value FROM schema_meta WHERE key = 'last_detected_at'`,
  )[0]?.value || null;
  const stale = !!(lastExtracted && (!lastDetected || lastExtracted > lastDetected));
  // Stamp this detect run.
  store.exec(
    `INSERT INTO schema_meta (key, value) VALUES ('last_detected_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [new Date().toISOString()],
  );

  // Cross-detector consistency pass: surface papers that appear in
  // logically conflicting detector outputs (e.g. citation_centrality
  // top-N AND lof_novelty top-N — "core to the field" AND "outlier").
  // Doesn't change any candidate; just adds a `coherence_warnings`
  // array so the UI can show "these signals disagree".
  // Top-K for coherence checks scales with the corpus-adaptive topK:
  // 1/5th of the detector cap, bounded to a sane window.
  const coherenceN = Math.max(5, Math.min(20, Math.round((thresholds.topK || 50) / 5)));
  const coherenceWarnings = collectCoherenceConflicts(byType, coherenceN);

  return {
    byType,
    combined: combined.slice(0, topK),
    summary: {
      total: combined.length,
      per_type: perType,
    },
    precondition_warnings: preconditionWarnings,
    rerank_note: rerankNote,
    coherence_warnings: coherenceWarnings,
    thresholds,
    last_extracted_at: lastExtracted,
    last_detected_at: lastDetected,
    was_stale: stale,
  };
}

// Paper-level cross-detector consistency. Three classes of conflict /
// stack we surface:
//   1. central + novel  — citation_centrality top-N AND a novelty
//      detector top-N. The paper is simultaneously "core to the field"
//      and "an outlier"; the user must pick one framing.
//   2. signal_stack     — paper appears in 3+ detectors' top-N. This
//      isn't a conflict but the user should review whether to dismiss
//      the redundant signals.
//   3. orphan + cited   — theoretical_gap orphan contributing-paper
//      that is also citation_centrality top-N. The paper anchors a
//      field that allegedly has no theoretical framework — review.
function collectCoherenceConflicts(byType, topN_size = 10) {
  const out = [];
  const topN = (type) => new Set(
    (byType[type]?.candidates || []).slice(0, topN_size).map((c) => c.paper_id).filter(Boolean),
  );
  const central = topN('citation_centrality');
  const lof = topN('lof_novelty');
  const ngram = topN('ngram_novelty');

  // 1. Central AND novel.
  for (const pid of central) {
    if (lof.has(pid) || ngram.has(pid)) {
      out.push({
        paper_id: pid,
        kind: 'central_and_novel',
        message: `${pid}: citation-central AND novelty outlier — review which framing applies.`,
      });
    }
  }

  // 2. Signal stack: paper appears in ≥3 detectors' contributing lists.
  const appearances = new Map();
  for (const [type, report] of Object.entries(byType)) {
    const seen = new Set();
    for (const c of (report.candidates || []).slice(0, topN_size)) {
      const papers = [];
      if (c.paper_id) papers.push(c.paper_id);
      if (Array.isArray(c.contributing_papers)) papers.push(...c.contributing_papers);
      else if (c.contributing_papers && typeof c.contributing_papers === 'object') {
        for (const v of Object.values(c.contributing_papers)) {
          if (Array.isArray(v)) papers.push(...v);
        }
      }
      for (const p of papers) {
        if (!p || seen.has(`${type}:${p}`)) continue;
        seen.add(`${type}:${p}`);
        if (!appearances.has(p)) appearances.set(p, new Set());
        appearances.get(p).add(type);
      }
    }
  }
  for (const [pid, types] of appearances) {
    if (types.size >= 3) {
      out.push({
        paper_id: pid,
        kind: 'signal_stack',
        types: [...types],
        message: `${pid}: flagged by ${types.size} detectors (${[...types].join(', ')}) — likely a load-bearing paper or duplicate signal worth reviewing.`,
      });
    }
  }

  // 3. Theoretical orphan + central.
  const orphans = new Set();
  for (const c of (byType.theoretical?.candidates || []).slice(0, topN_size)) {
    if (c.cell?.subtype === 'orphan' && Array.isArray(c.contributing_papers)) {
      for (const p of c.contributing_papers) orphans.add(p);
    }
  }
  for (const pid of orphans) {
    if (central.has(pid)) {
      out.push({
        paper_id: pid,
        kind: 'orphan_and_central',
        message: `${pid}: anchors a category flagged as theoretically orphan, yet is citation-central — either the orphan flag is wrong or this paper IS the de-facto framework.`,
      });
    }
  }

  return out;
}

export {
  detectMethodologicalGap,
  detectKnowledgeGap,
  detectPopulationGap,
  detectEvidenceGap,
  detectEmpiricalGap,
  detectPracticalGap,
  detectTheoreticalGap,
  detectCitationCentrality,
  detectMainPath,
  detectCoCitation,
  detectBibliographicCoupling,
  detectTemporalTrends,
  detectLofNovelty,
  detectNgramNovelty,
  rerankByCitations,
  buildClusters,
};
