// detectors/citation_centrality.mjs
//
// PageRank over the citation graph. Identifies the most-cited papers
// weighted by the importance of their citers — central anchors of the
// corpus that any defensible literature review should reference.
//
// Why PageRank over raw citation counts: raw counts treat every incoming
// citation as equal. PageRank correctly down-weights citations from
// peripheral papers and up-weights citations from already-central ones.
// Same intuition the original Brin & Page paper used for web pages.
//
// Implementation: load the citation edge list from SQLite, run 30
// PageRank iterations in JS (damping = 0.85), filter results to papers
// that exist in the corpus (`papers` table) so we don't surface
// out-of-corpus targets the student can't reach.
//
// Pure SQL+JS, no LLM. Deterministic for a fixed corpus.

import * as store from '../store.mjs';
import { pickThresholds } from './_scale.mjs';

const DEFAULT_DAMPING = 0.85;
const DEFAULT_ITERATIONS = 30;
const DEFAULT_CONVERGENCE = 1e-6;

export async function detectCitationCentrality(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const damping = opts.damping ?? DEFAULT_DAMPING;
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const convergence = opts.convergence ?? DEFAULT_CONVERGENCE;
  // Cap candidates at corpus-adaptive topK so we don't return 30
  // "top central" papers from a 20-paper corpus.
  const maxCandidates = opts.maxCandidates ?? Math.min(30, t.topK);

  const edges = store.query('SELECT from_paper, to_paper FROM citations');
  if (edges.length === 0) {
    return { candidates: [], total_candidates: 0, reason: 'no_citations' };
  }

  // Collect nodes + out-degree + reverse adjacency.
  const nodes = new Set();
  const outDeg = new Map();
  const inAdj = new Map();          // to_paper → [from_papers]
  for (const e of edges) {
    nodes.add(e.from_paper);
    nodes.add(e.to_paper);
    outDeg.set(e.from_paper, (outDeg.get(e.from_paper) || 0) + 1);
    if (!inAdj.has(e.to_paper)) inAdj.set(e.to_paper, []);
    inAdj.get(e.to_paper).push(e.from_paper);
  }
  const N = nodes.size;
  const nodeList = [...nodes];

  // Initialise PR uniformly.
  let pr = new Map();
  for (const n of nodeList) pr.set(n, 1 / N);

  // Iterate.
  let actualIters = iterations;
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map();
    // Base teleport probability.
    const teleport = (1 - damping) / N;
    // Handle dangling nodes (no out-edges): distribute their mass
    // uniformly across all nodes to prevent rank sink.
    let danglingMass = 0;
    for (const n of nodeList) {
      if ((outDeg.get(n) || 0) === 0) danglingMass += pr.get(n) || 0;
    }
    const danglingShare = damping * danglingMass / N;
    for (const n of nodeList) {
      let inSum = 0;
      const inputs = inAdj.get(n) || [];
      for (const u of inputs) {
        const dou = outDeg.get(u) || 0;
        if (dou > 0) inSum += (pr.get(u) || 0) / dou;
      }
      next.set(n, teleport + danglingShare + damping * inSum);
    }
    // Check convergence — L1 delta.
    let delta = 0;
    for (const n of nodeList) delta += Math.abs((next.get(n) || 0) - (pr.get(n) || 0));
    pr = next;
    if (delta < convergence) { actualIters = iter + 1; break; }
  }

  // Filter to in-corpus papers, sort by PR.
  const inCorpus = new Set(
    store.query('SELECT paper_id FROM papers').map((r) => r.paper_id),
  );
  const ranked = nodeList
    .filter((n) => inCorpus.has(n))
    .map((n) => ({ paper_id: n, pr: pr.get(n) || 0, in_deg: (inAdj.get(n) || []).length }))
    .sort((a, b) => b.pr - a.pr)
    .slice(0, maxCandidates);

  // Attach titles so the output is readable.
  if (ranked.length === 0) {
    return { candidates: [], total_candidates: 0, reason: 'no_in_corpus_papers_in_citation_graph' };
  }
  const titleRows = store.query(
    `SELECT paper_id, title, year FROM papers WHERE paper_id IN (${ranked.map(() => '?').join(',')})`,
    ranked.map((r) => r.paper_id),
  );
  const titles = new Map(titleRows.map((r) => [r.paper_id, r]));

  const candidates = ranked.map((r) => {
    const info = titles.get(r.paper_id) || {};
    return {
      cell: { paper_id: r.paper_id },
      statistic: {
        pagerank: Number(r.pr.toFixed(6)),
        in_degree: r.in_deg,
      },
      contributing_papers: [r.paper_id],
      description: `Citation-central paper: ${info.title || r.paper_id} (${info.year || '?'}) — PageRank ${r.pr.toFixed(4)}, ${r.in_deg} citations from other corpus papers.`,
      salience: r.pr * 1000,        // scale up so cross-type ranking is comparable
    };
  });

  return {
    candidates,
    total_candidates: candidates.length,
    diagnostics: {
      n_nodes: N,
      n_edges: edges.length,
      iterations_run: actualIters,
      damping,
    },
  };
}

export const TYPE = 'citation_centrality';
