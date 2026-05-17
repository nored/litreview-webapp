// detectors/main_path.mjs
//
// Main Path Analysis (MPA). Traces the "backbone" of the field via the
// most-traversed citation chains. Based on Hummon & Doreian's
// Search Path Count (SPC, 1989): each edge's significance is the
// number of citation paths from corpus *sources* (papers with no
// incoming citations from inside the corpus) to corpus *sinks* (papers
// with no outgoing citations) that pass through it.
//
// Algorithm:
//
//   1. Build the in-corpus citation graph as a directed adjacency list.
//   2. Filter to a DAG by dropping any back-edges that introduce cycles
//      (rare in citation networks; this is a robustness step). We
//      compute a topological order via DFS; back-edges are skipped.
//   3. Forward count: paths_to[u] = sum over predecessors of paths_to.
//      paths_to[source] = 1.
//   4. Backward count: paths_from[u] = sum over successors of paths_from.
//      paths_from[sink] = 1.
//   5. SPC(u→v) = paths_to[u] * paths_from[v].
//   6. The main path is a chain starting from the highest-SPC edge and
//      extending greedily forward + backward by best-SPC out-edge / best-
//      SPC in-edge.
//
// Output: a single candidate carrying the chain as a list of papers in
// chronological-traversal order, with each step's SPC weight.

import * as store from '../store.mjs';
import { pickThresholds } from './_scale.mjs';

const DEFAULT_MAX_CHAINS = 1;

function topoOrderDFS(nodes, adjOut) {
  const visited = new Map();   // node → 1 (visiting) | 2 (done)
  const order = [];
  function visit(n) {
    if (visited.get(n) === 2) return;
    if (visited.get(n) === 1) return;   // back-edge — skip
    visited.set(n, 1);
    for (const next of adjOut.get(n) || []) visit(next);
    visited.set(n, 2);
    order.push(n);
  }
  for (const n of nodes) visit(n);
  return order.reverse();
}

export async function detectMainPath(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const maxChains = opts.maxChains ?? DEFAULT_MAX_CHAINS;
  // Chain length cap scales with corpus — a 20-paper corpus shouldn't
  // try to thread 30-paper chains.
  const maxChainLength = opts.maxChainLength ?? Math.max(5, Math.min(30, Math.round(t.corpus_size / 4)));

  // In-corpus edges only — out-of-corpus targets don't help us pick a
  // *defensible* path the student can cite.
  const edges = store.query(`
    SELECT c.from_paper, c.to_paper
      FROM citations c
      JOIN papers fp ON fp.paper_id = c.from_paper
      JOIN papers tp ON tp.paper_id = c.to_paper
  `);
  if (edges.length === 0) {
    return { candidates: [], total_candidates: 0, reason: 'no_in_corpus_citations' };
  }

  // Build adjacency.
  const nodes = new Set();
  const adjOut = new Map();
  const adjIn = new Map();
  for (const e of edges) {
    nodes.add(e.from_paper);
    nodes.add(e.to_paper);
    if (!adjOut.has(e.from_paper)) adjOut.set(e.from_paper, []);
    adjOut.get(e.from_paper).push(e.to_paper);
    if (!adjIn.has(e.to_paper)) adjIn.set(e.to_paper, []);
    adjIn.get(e.to_paper).push(e.from_paper);
  }
  const nodeList = [...nodes];

  // Topological order (DFS-based; back-edges silently skipped).
  const topo = topoOrderDFS(nodeList, adjOut);

  // Forward path count.
  const pathsTo = new Map();
  for (const n of topo) {
    const ins = adjIn.get(n) || [];
    if (ins.length === 0) {
      pathsTo.set(n, 1);   // source
    } else {
      let s = 0;
      for (const u of ins) s += pathsTo.get(u) || 0;
      pathsTo.set(n, s);
    }
  }

  // Backward path count (reverse topo).
  const pathsFrom = new Map();
  for (let i = topo.length - 1; i >= 0; i--) {
    const n = topo[i];
    const outs = adjOut.get(n) || [];
    if (outs.length === 0) {
      pathsFrom.set(n, 1);   // sink
    } else {
      let s = 0;
      for (const v of outs) s += pathsFrom.get(v) || 0;
      pathsFrom.set(n, s);
    }
  }

  // SPC for every edge.
  const edgeSpc = edges.map((e) => ({
    ...e,
    spc: (pathsTo.get(e.from_paper) || 0) * (pathsFrom.get(e.to_paper) || 0),
  })).sort((a, b) => b.spc - a.spc);

  if (edgeSpc.length === 0 || edgeSpc[0].spc === 0) {
    return { candidates: [], total_candidates: 0, reason: 'no_paths_through_corpus' };
  }

  // Build chains greedily from the top edge, extending in both
  // directions by highest-SPC neighbour. Avoids revisiting nodes.
  const candidates = [];
  const usedNodes = new Set();
  for (const seed of edgeSpc) {
    if (candidates.length >= maxChains) break;
    if (usedNodes.has(seed.from_paper) || usedNodes.has(seed.to_paper)) continue;
    const chain = [
      { from: seed.from_paper, to: seed.to_paper, spc: seed.spc },
    ];
    const seen = new Set([seed.from_paper, seed.to_paper]);
    // Extend forward from seed.to_paper.
    let head = seed.to_paper;
    while (chain.length < maxChainLength) {
      const outs = (adjOut.get(head) || []).filter((n) => !seen.has(n));
      if (outs.length === 0) break;
      const best = outs
        .map((n) => ({ n, spc: (pathsTo.get(head) || 0) * (pathsFrom.get(n) || 0) }))
        .sort((a, b) => b.spc - a.spc)[0];
      if (!best || best.spc === 0) break;
      chain.push({ from: head, to: best.n, spc: best.spc });
      seen.add(best.n);
      head = best.n;
    }
    // Extend backward from seed.from_paper.
    let tail = seed.from_paper;
    while (chain.length < maxChainLength) {
      const ins = (adjIn.get(tail) || []).filter((n) => !seen.has(n));
      if (ins.length === 0) break;
      const best = ins
        .map((n) => ({ n, spc: (pathsTo.get(n) || 0) * (pathsFrom.get(tail) || 0) }))
        .sort((a, b) => b.spc - a.spc)[0];
      if (!best || best.spc === 0) break;
      chain.unshift({ from: best.n, to: tail, spc: best.spc });
      seen.add(best.n);
      tail = best.n;
    }
    for (const n of seen) usedNodes.add(n);

    // Materialise as paper id list + title lookup.
    const paperOrder = [chain[0].from, ...chain.map((e) => e.to)];
    const titleRows = store.query(
      `SELECT paper_id, title, year FROM papers WHERE paper_id IN (${paperOrder.map(() => '?').join(',')})`,
      paperOrder,
    );
    const titles = new Map(titleRows.map((r) => [r.paper_id, r]));
    candidates.push({
      cell: { chain_papers: paperOrder },
      statistic: {
        chain_length: chain.length,
        total_spc: chain.reduce((s, e) => s + e.spc, 0),
        max_spc: chain[0].spc,
      },
      contributing_papers: paperOrder,
      chain_detail: chain.map((e) => ({
        from: e.from, to: e.to, spc: e.spc,
        from_title: titles.get(e.from)?.title || null,
        to_title: titles.get(e.to)?.title || null,
      })),
      description: `Main development trajectory: ${chain.length} citation hop(s) tracing the highest-traversed chain through the corpus.`,
      salience: chain.reduce((s, e) => s + e.spc, 0),
    });
  }

  return {
    candidates,
    total_candidates: candidates.length,
    diagnostics: {
      n_nodes: nodes.size,
      n_edges: edges.length,
      max_spc: edgeSpc[0].spc,
    },
  };
}

export const TYPE = 'main_path';
