// detect_phase4.mjs
//
// The 7 Miles 2017 gap types rewritten as queries over the emergent
// cluster + reference graph. No static taxonomies, no `paper_field` enum
// cells. Each detector reads from the v6 schema (paper_clusters,
// claim_clusters, method_clusters, entity_clusters, citation_markers,
// reference_list, results) and emits candidates in the same shape the
// v1 detectors used — so the corpus-shape view + downstream dismiss /
// drill-down code work without changes.
//
// Candidate shape (per Miles output):
//   {
//     type: 'evidence' | 'knowledge' | ...,
//     cell: { ... },                       // emergent identifiers, not enum cells
//     statistic: { ... },                  // the numbers that motivated the flag
//     contributing_papers: [paper_id, ...],
//     description: string,
//     salience: number,
//     signature: string                    // for dismissal stickiness
//   }
//
// Salience is normalised per detector to ~0–10 range so the cross-type
// combined list ranks fairly. Higher = stronger gap signal.

import * as store from './store.mjs';

const round = (x, n = 3) => Number(Number(x).toFixed(n));

// ─────────────────────────────────────────────────────────────────────────
// Type 1 — EVIDENCE gap
//
// High variance (range / CV) on the same (metric, dataset) pair across
// multiple papers. When the corpus disagrees on a number, that's an
// evidence gap.
// ─────────────────────────────────────────────────────────────────────────

export async function detectEvidence(opts = {}) {
  await store.init();
  const minPapers = opts.minPapers ?? 2;
  const minCV = opts.minCV ?? 0.10;     // 10% variation
  const rows = store.query(`
    SELECT metric, dataset,
           COUNT(*) AS n,
           MIN(value) AS lo,
           MAX(value) AS hi,
           AVG(value) AS mean,
           group_concat(DISTINCT paper_id) AS papers,
           group_concat(value, '|') AS values
      FROM results
     WHERE dataset IS NOT NULL AND dataset <> ''
     GROUP BY metric, dataset
    HAVING n >= ?`, [minPapers]);
  const candidates = [];
  for (const r of rows) {
    const values = String(r.values || '').split('|').map(Number).filter(Number.isFinite);
    if (values.length < minPapers) continue;
    const mean = r.mean;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    const cv = mean !== 0 ? std / Math.abs(mean) : 0;
    const range = r.hi - r.lo;
    if (cv < minCV) continue;
    candidates.push({
      type: 'evidence',
      cell: { metric: r.metric, dataset: r.dataset },
      statistic: {
        n_papers: r.n,
        mean: round(mean),
        std: round(std),
        cv: round(cv),
        range: round(range),
        min: round(r.lo),
        max: round(r.hi),
      },
      contributing_papers: String(r.papers || '').split(',').filter(Boolean),
      description: `${r.n} papers report ${r.metric} on ${r.dataset} with CV=${(cv * 100).toFixed(1)}% (range ${round(r.lo)}–${round(r.hi)}). The literature disagrees.`,
      salience: round(r.n * cv * 10, 2),
      signature: `evidence:metric=${r.metric}|dataset=${r.dataset}`,
    });
  }
  candidates.sort((a, b) => b.salience - a.salience);
  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────
// Type 2 — KNOWLEDGE gap
//
// A (paper_cluster × method_cluster) cell is empty while neighbouring
// cells are dense. The "topic" and "method" axes EMERGED from clustering,
// so this captures combinations of (what's studied × how it's studied)
// that the corpus hasn't explored yet.
// ─────────────────────────────────────────────────────────────────────────

export async function detectKnowledge(opts = {}) {
  await store.init();
  const minNeighbourDensity = opts.minNeighbourDensity ?? 2;
  // All (paper_cluster, method_cluster) observed populated cells.
  const populated = store.query(`
    SELECT p.paper_cluster_id  AS pc,
           p.method_cluster_id AS mc,
           COUNT(*)            AS n,
           group_concat(p.paper_id) AS papers
      FROM papers p
     WHERE p.paper_cluster_id IS NOT NULL
       AND p.method_cluster_id IS NOT NULL
     GROUP BY p.paper_cluster_id, p.method_cluster_id
  `);
  if (populated.length === 0) return [];
  // Build (pc × mc) matrix in-memory.
  const cellPapers = new Map();   // "pc|mc" -> { n, papers[] }
  const pcSet = new Set(), mcSet = new Set();
  for (const r of populated) {
    cellPapers.set(`${r.pc}|${r.mc}`, { n: r.n, papers: String(r.papers || '').split(',') });
    pcSet.add(r.pc); mcSet.add(r.mc);
  }
  // For each empty (pc, mc), count neighbouring density (same pc OR same mc).
  const pcLabel = new Map();
  for (const r of store.query('SELECT cluster_id, auto_label FROM paper_clusters')) pcLabel.set(r.cluster_id, r.auto_label);
  const mcLabel = new Map();
  for (const r of store.query('SELECT cluster_id, auto_label FROM method_clusters')) mcLabel.set(r.cluster_id, r.auto_label);

  const pcs = [...pcSet], mcs = [...mcSet];
  const candidates = [];
  for (const pc of pcs) for (const mc of mcs) {
    if (cellPapers.has(`${pc}|${mc}`)) continue;
    // Neighbouring density: sum of papers in same pc (any mc) + same mc (any pc).
    let pcRow = 0; const pcRowPapers = new Set();
    for (const mc2 of mcs) {
      const c = cellPapers.get(`${pc}|${mc2}`);
      if (c) { pcRow += c.n; for (const p of c.papers) pcRowPapers.add(p); }
    }
    let mcCol = 0; const mcColPapers = new Set();
    for (const pc2 of pcs) {
      const c = cellPapers.get(`${pc2}|${mc}`);
      if (c) { mcCol += c.n; for (const p of c.papers) mcColPapers.add(p); }
    }
    const neighbours = pcRow + mcCol;
    if (neighbours < minNeighbourDensity) continue;
    const contributing = [...new Set([...pcRowPapers, ...mcColPapers])];
    candidates.push({
      type: 'knowledge',
      cell: {
        paper_cluster_id: pc,
        paper_cluster_label: pcLabel.get(pc) || null,
        method_cluster_id: mc,
        method_cluster_label: mcLabel.get(mc) || null,
      },
      statistic: {
        cell_count: 0,
        row_density: pcRow,
        column_density: mcCol,
        neighbours,
      },
      contributing_papers: contributing,
      description: `No paper studies "${pcLabel.get(pc) || pc}" using "${mcLabel.get(mc) || mc}". The topic has ${pcRow} papers across other methods; the method has ${mcCol} papers across other topics. The intersection is empty.`,
      salience: round(neighbours / 2, 2),
      signature: `knowledge:pc=${pc}|mc=${mc}`,
    });
  }
  candidates.sort((a, b) => b.salience - a.salience);
  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────
// Type 3 — METHODOLOGICAL gap
//
// For each paper_cluster, look at which method_clusters its papers use,
// and which method_clusters EXIST in the corpus but haven't been
// applied to this topic. Larger candidate = bigger missing method.
// ─────────────────────────────────────────────────────────────────────────

export async function detectMethodological(opts = {}) {
  await store.init();
  const minPaperClusterSize = opts.minPaperClusterSize ?? 2;
  const pcUsed = store.query(`
    SELECT p.paper_cluster_id AS pc, p.method_cluster_id AS mc, COUNT(*) AS n,
           group_concat(p.paper_id) AS papers
      FROM papers p
     WHERE p.paper_cluster_id IS NOT NULL AND p.method_cluster_id IS NOT NULL
     GROUP BY p.paper_cluster_id, p.method_cluster_id
  `);
  if (pcUsed.length === 0) return [];
  const usedByPc = new Map();           // pc -> Set(mc)
  const papersByPc = new Map();         // pc -> Set(paper_id)
  for (const r of pcUsed) {
    if (!usedByPc.has(r.pc)) usedByPc.set(r.pc, new Set());
    usedByPc.get(r.pc).add(r.mc);
    if (!papersByPc.has(r.pc)) papersByPc.set(r.pc, new Set());
    for (const p of String(r.papers || '').split(',')) papersByPc.get(r.pc).add(p);
  }
  const allMethodClusters = store.query(`SELECT cluster_id, auto_label, member_count FROM method_clusters ORDER BY member_count DESC`);
  const pcRows = store.query(`SELECT cluster_id, auto_label, member_count FROM paper_clusters`);
  const candidates = [];
  for (const pc of pcRows) {
    if (pc.member_count < minPaperClusterSize) continue;
    const used = usedByPc.get(pc.cluster_id) || new Set();
    for (const mc of allMethodClusters) {
      if (used.has(mc.cluster_id)) continue;
      if (mc.member_count < 2) continue;   // tiny method clusters aren't a meaningful "missing method"
      candidates.push({
        type: 'methodological',
        cell: {
          paper_cluster_id: pc.cluster_id,
          paper_cluster_label: pc.auto_label,
          missing_method_cluster_id: mc.cluster_id,
          missing_method_label: mc.auto_label,
        },
        statistic: {
          topic_papers: pc.member_count,
          method_papers_elsewhere: mc.member_count,
          methods_already_tried: used.size,
        },
        contributing_papers: [...(papersByPc.get(pc.cluster_id) || [])],
        description: `Topic "${pc.auto_label || pc.cluster_id}" (${pc.member_count} papers, ${used.size} methods tried) has not applied method "${mc.auto_label || mc.cluster_id}", which has ${mc.member_count} papers in the corpus.`,
        salience: round((pc.member_count * mc.member_count) / 10, 2),
        signature: `methodological:pc=${pc.cluster_id}|mc=${mc.cluster_id}`,
      });
    }
  }
  candidates.sort((a, b) => b.salience - a.salience);
  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────
// Type 4 — EMPIRICAL gap
//
// Claim clusters with stance distribution dominated by "theorises" (or
// "asserts") but no "validates". A claim that the literature keeps making
// without anyone empirically demonstrating it.
// ─────────────────────────────────────────────────────────────────────────

export async function detectEmpirical(opts = {}) {
  await store.init();
  const minTheorises = opts.minTheorises ?? 2;
  const rows = store.query(`SELECT cluster_id, auto_label, member_count, stance_distribution_json FROM claim_clusters`);
  const candidates = [];
  for (const r of rows) {
    let dist;
    try { dist = JSON.parse(r.stance_distribution_json || '{}'); } catch { dist = {}; }
    const theorises = dist.theorises || 0;
    const validates = dist.validates || 0;
    const asserts   = dist.asserts   || 0;
    if (theorises < minTheorises) continue;
    if (validates >= 1) continue;
    // Pull contributing papers from this cluster.
    const papers = store.query(
      `SELECT DISTINCT paper_id FROM claims WHERE cluster_id = ?`,
      [r.cluster_id],
    ).map((x) => x.paper_id);
    candidates.push({
      type: 'empirical',
      cell: {
        claim_cluster_id: r.cluster_id,
        claim_cluster_label: r.auto_label,
      },
      statistic: {
        theorises, validates, asserts,
        cluster_size: r.member_count,
      },
      contributing_papers: papers,
      description: `Claim cluster "${r.auto_label || r.cluster_id}" has ${theorises} theorised claims but 0 validations. The hypothesis is repeated without empirical confirmation.`,
      salience: round(theorises * 1.5, 2),
      signature: `empirical:cluster=${r.cluster_id}`,
    });
  }
  candidates.sort((a, b) => b.salience - a.salience);
  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────
// Type 5 — THEORETICAL gap
//
// Paper clusters with many findings but few framework citations. Driven
// by: per paper_cluster, count claim_type=finding vs claim_type=framework.
// Also flags paper_clusters where citation stance distribution lacks any
// "background" / supportive theory citations.
// ─────────────────────────────────────────────────────────────────────────

export async function detectTheoretical(opts = {}) {
  await store.init();
  const minFindings = opts.minFindings ?? 2;
  const maxFrameworkRatio = opts.maxFrameworkRatio ?? 0.1;   // findings ≫ frameworks
  // Per paper_cluster: count claim_type counts.
  const rows = store.query(`
    SELECT p.paper_cluster_id AS pc,
           c.claim_type,
           COUNT(*) AS n
      FROM claims c
      INNER JOIN papers p ON p.paper_id = c.paper_id
     WHERE p.paper_cluster_id IS NOT NULL
     GROUP BY p.paper_cluster_id, c.claim_type
  `);
  if (rows.length === 0) return [];
  const byPc = new Map();        // pc -> { type: count }
  for (const r of rows) {
    if (!byPc.has(r.pc)) byPc.set(r.pc, {});
    byPc.get(r.pc)[r.claim_type] = r.n;
  }
  const pcLabel = new Map();
  for (const r of store.query('SELECT cluster_id, auto_label, member_count FROM paper_clusters')) {
    pcLabel.set(r.cluster_id, { label: r.auto_label, size: r.member_count });
  }
  const candidates = [];
  for (const [pc, counts] of byPc) {
    const findings  = counts.finding   || 0;
    const framework = counts.framework || 0;
    if (findings < minFindings) continue;
    const ratio = findings === 0 ? 0 : framework / findings;
    if (ratio > maxFrameworkRatio) continue;
    const papers = store.query(`SELECT paper_id FROM papers WHERE paper_cluster_id = ?`, [pc]).map((x) => x.paper_id);
    const info = pcLabel.get(pc) || {};
    candidates.push({
      type: 'theoretical',
      cell: {
        paper_cluster_id: pc,
        paper_cluster_label: info.label,
      },
      statistic: {
        n_findings: findings,
        n_framework: framework,
        ratio: round(ratio),
        cluster_size: info.size,
      },
      contributing_papers: papers,
      description: `Topic "${info.label || pc}" produces ${findings} empirical findings but cites only ${framework} theoretical frameworks (ratio ${(ratio * 100).toFixed(0)}%). The phenomenon is studied without a shared theoretical anchor.`,
      salience: round((findings - framework) * 0.5, 2),
      signature: `theoretical:pc=${pc}`,
    });
  }
  candidates.sort((a, b) => b.salience - a.salience);
  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────
// Type 6 — POPULATION gap
//
// Entity clusters whose auto_label resembles a "population descriptor"
// (cohort / patient / user / participant / etc.) — count occurrences
// per paper_cluster; flag pairs where one paper_cluster has many such
// mentions and a neighbouring cluster (same paper-cluster context) has
// few or none.
//
// Without static field tags, we use the cluster auto_label as a soft
// signal. The detector reports candidates as "topic X has population
// descriptor Y barely covered relative to topic Z". When labels are LLM-
// generated this is reliable; with bigram fallback it's noisier.
// ─────────────────────────────────────────────────────────────────────────

const POPULATION_LABEL_RE = /\b(population|cohort|patient|user|participant|subject|demograph|sample|group)\b/i;

export async function detectPopulation(opts = {}) {
  await store.init();
  // Find entity_clusters whose auto_label looks population-like.
  const popClusters = store.query(`SELECT cluster_id, auto_label, member_count FROM entity_clusters WHERE auto_label IS NOT NULL`)
    .filter((r) => POPULATION_LABEL_RE.test(r.auto_label || ''));
  if (popClusters.length === 0) return [];
  // Per paper_cluster: how many spans from each pop entity cluster?
  const grid = store.query(`
    SELECT p.paper_cluster_id AS pc, es.cluster_id AS ec, COUNT(*) AS n,
           group_concat(DISTINCT p.paper_id) AS papers
      FROM entity_spans es
      INNER JOIN papers p ON p.paper_id = es.paper_id
     WHERE es.cluster_id IS NOT NULL
       AND p.paper_cluster_id IS NOT NULL
       AND es.cluster_id IN (${popClusters.map(() => '?').join(',')})
     GROUP BY p.paper_cluster_id, es.cluster_id`,
    popClusters.map((r) => r.cluster_id),
  );
  const byPcEc = new Map();
  for (const r of grid) byPcEc.set(`${r.pc}|${r.ec}`, { n: r.n, papers: String(r.papers || '').split(',') });
  const pcRows = store.query(`SELECT cluster_id, auto_label, member_count FROM paper_clusters`);
  const candidates = [];
  for (const pc of pcRows) {
    for (const ec of popClusters) {
      const cell = byPcEc.get(`${pc.cluster_id}|${ec.cluster_id}`);
      if (cell) continue;     // already covered
      // Population mentioned by other paper_clusters?
      const altCount = grid.filter((g) => g.ec === ec.cluster_id && g.pc !== pc.cluster_id).reduce((s, g) => s + g.n, 0);
      if (altCount === 0) continue;
      const papers = store.query(`SELECT paper_id FROM papers WHERE paper_cluster_id = ?`, [pc.cluster_id]).map((x) => x.paper_id);
      candidates.push({
        type: 'population',
        cell: {
          paper_cluster_id: pc.cluster_id,
          paper_cluster_label: pc.auto_label,
          population_cluster_id: ec.cluster_id,
          population_label: ec.auto_label,
        },
        statistic: {
          mentions_in_topic: 0,
          mentions_in_other_topics: altCount,
          topic_papers: pc.member_count,
        },
        contributing_papers: papers,
        description: `Topic "${pc.auto_label || pc.cluster_id}" has 0 mentions of population "${ec.auto_label}", which is mentioned ${altCount} times in other topics. This population is under-studied in this topic.`,
        salience: round(altCount * 0.5, 2),
        signature: `population:pc=${pc.cluster_id}|ec=${ec.cluster_id}`,
      });
    }
  }
  candidates.sort((a, b) => b.salience - a.salience);
  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────
// Type 7 — PRACTICAL-KNOWLEDGE gap
//
// Claim clusters whose stance distribution diverges across paper_clusters.
// I.e. claims in this cluster have a "supports / validates" tilt within
// one paper_cluster, but "challenges / contradicts" within another —
// theory/practice divide.
// ─────────────────────────────────────────────────────────────────────────

export async function detectPractical(opts = {}) {
  await store.init();
  // For each claim_cluster, collect (paper_cluster_id, stance, count).
  const rows = store.query(`
    SELECT c.cluster_id AS cc, p.paper_cluster_id AS pc, c.stance, COUNT(*) AS n
      FROM claims c
      INNER JOIN papers p ON p.paper_id = c.paper_id
     WHERE c.cluster_id IS NOT NULL
       AND p.paper_cluster_id IS NOT NULL
       AND c.stance IS NOT NULL
     GROUP BY c.cluster_id, p.paper_cluster_id, c.stance
  `);
  if (rows.length === 0) return [];
  // Group by claim_cluster.
  const byCc = new Map();
  for (const r of rows) {
    if (!byCc.has(r.cc)) byCc.set(r.cc, new Map());
    const pcMap = byCc.get(r.cc);
    if (!pcMap.has(r.pc)) pcMap.set(r.pc, {});
    pcMap.get(r.pc)[r.stance] = r.n;
  }
  const ccLabel = new Map();
  for (const r of store.query('SELECT cluster_id, auto_label FROM claim_clusters')) ccLabel.set(r.cluster_id, r.auto_label);
  const pcLabel = new Map();
  for (const r of store.query('SELECT cluster_id, auto_label FROM paper_clusters')) pcLabel.set(r.cluster_id, r.auto_label);
  // Helper: dominant stance for a paper_cluster within this claim cluster.
  function dominant(stanceCounts) {
    let best = null, bestN = 0;
    for (const [s, n] of Object.entries(stanceCounts)) if (n > bestN) { bestN = n; best = s; }
    return best;
  }
  const SUPPORTIVE = new Set(['asserts', 'validates', 'extends']);
  const ADVERSARIAL = new Set(['challenges']);
  const candidates = [];
  for (const [cc, pcMap] of byCc) {
    if (pcMap.size < 2) continue;     // need ≥ 2 paper-clusters to compare
    let supportiveGroups = [];
    let adversarialGroups = [];
    for (const [pc, stanceCounts] of pcMap) {
      const dom = dominant(stanceCounts);
      if (SUPPORTIVE.has(dom)) supportiveGroups.push(pc);
      else if (ADVERSARIAL.has(dom)) adversarialGroups.push(pc);
    }
    if (supportiveGroups.length === 0 || adversarialGroups.length === 0) continue;
    const supportPapers = new Set(), advPapers = new Set();
    for (const pc of supportiveGroups) for (const p of store.query('SELECT paper_id FROM papers WHERE paper_cluster_id = ?', [pc])) supportPapers.add(p.paper_id);
    for (const pc of adversarialGroups) for (const p of store.query('SELECT paper_id FROM papers WHERE paper_cluster_id = ?', [pc])) advPapers.add(p.paper_id);
    candidates.push({
      type: 'practical',
      cell: {
        claim_cluster_id: cc,
        claim_cluster_label: ccLabel.get(cc),
      },
      statistic: {
        supportive_paper_clusters: supportiveGroups.map((pc) => ({ id: pc, label: pcLabel.get(pc) })),
        adversarial_paper_clusters: adversarialGroups.map((pc) => ({ id: pc, label: pcLabel.get(pc) })),
        n_supportive_papers: supportPapers.size,
        n_adversarial_papers: advPapers.size,
      },
      contributing_papers: [...supportPapers, ...advPapers],
      description: `Claim cluster "${ccLabel.get(cc) || cc}" sees ${supportiveGroups.length} topic-cluster(s) supporting it and ${adversarialGroups.length} contradicting it — a practice/theory divide.`,
      salience: round((supportPapers.size + advPapers.size) * 0.8, 2),
      signature: `practical:cluster=${cc}`,
    });
  }
  candidates.sort((a, b) => b.salience - a.salience);
  return candidates;
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────

const DETECTORS = {
  evidence:        detectEvidence,
  knowledge:       detectKnowledge,
  methodological:  detectMethodological,
  empirical:       detectEmpirical,
  theoretical:     detectTheoretical,
  population:      detectPopulation,
  practical:       detectPractical,
};

export const GAP_TYPES = Object.keys(DETECTORS);

/**
 * Run every detector. Returns:
 *   { byType: { [type]: { candidates, n } }, combined: [...top-K cross-type],
 *     elapsed_ms, preconditions: [...] }
 */
export async function detectAllPhase4(opts = {}) {
  await store.init();
  const startMs = Date.now();
  // Preconditions: warn the UI when the input tables are sparse so an
  // empty detector result is interpretable as "nothing was there to find"
  // rather than "detector is broken".
  const counts = store.query(`
    SELECT
      (SELECT COUNT(*) FROM paper_clusters)  AS n_paper_clusters,
      (SELECT COUNT(*) FROM method_clusters) AS n_method_clusters,
      (SELECT COUNT(*) FROM claim_clusters)  AS n_claim_clusters,
      (SELECT COUNT(*) FROM entity_clusters) AS n_entity_clusters,
      (SELECT COUNT(*) FROM results)         AS n_results,
      (SELECT COUNT(*) FROM citation_markers WHERE stance IS NOT NULL) AS n_stanced_citations
  `)[0] || {};
  const preconditions = [];
  if (counts.n_paper_clusters === 0)  preconditions.push('no paper_clusters — run /api/v2/cluster-phase3');
  if (counts.n_method_clusters === 0) preconditions.push('no method_clusters — run /api/v2/cluster-phase3');
  if (counts.n_claim_clusters === 0)  preconditions.push('no claim_clusters — Phase 2 needs a working AI provider for claims');
  if (counts.n_results === 0)         preconditions.push('no results — Phase 2 numerical extraction needs a working AI provider');

  const which = Array.isArray(opts.only) && opts.only.length
    ? opts.only.filter((t) => t in DETECTORS)
    : GAP_TYPES;
  const byType = {};
  let combined = [];
  for (const type of which) {
    try {
      const candidates = await DETECTORS[type](opts);
      byType[type] = { candidates, n: candidates.length };
      combined = combined.concat(candidates);
    } catch (e) {
      byType[type] = { candidates: [], n: 0, error: e?.message || String(e) };
    }
  }
  combined.sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
  const topK = opts.topK ?? 100;
  return {
    byType,
    combined: combined.slice(0, topK),
    summary: {
      total: combined.length,
      per_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.n])),
    },
    preconditions,
    input_counts: counts,
    elapsed_ms: Date.now() - startMs,
    detected_at: new Date().toISOString(),
  };
}
