// detectors/rerank.mjs
//
// Reranker that scales each candidate's salience by the bibliometric
// weight of its contributing papers. Intuition: a gap surrounded by
// highly-cited papers matters more than a gap surrounded by obscure
// ones. Same gap-detection logic produces the candidates; this layer
// adjusts their final ranking.
//
// Weight per paper: 1 + log(1 + in_corpus_citation_count). The +1 keeps
// uncited papers at weight 1 (no zero-multiplication problem); the log
// damps the effect of a few super-cited outliers.
//
// Per candidate: multiplier = mean(weight) over contributing_papers.
// Final salience = original_salience × multiplier. Returns a *new* array
// with the rerank applied; doesn't mutate input.

import * as store from '../store.mjs';

/**
 * Apply citation-weighted reranking to a list of detector candidates.
 *
 * candidates: as returned by detectAll().combined  OR  a single
 *             detector's .candidates array.
 *
 * Returns: a new array, sorted by reranked salience descending. Each
 * candidate gains a `rerank` field carrying { multiplier, paper_weights }
 * so the caller can show the why.
 *
 * opts:
 *   citationCountsCache  — optional Map<paper_id, count>. If absent, we
 *                          query once and reuse.
 *   normalisationBaseline — papers with > this many citations get the
 *                           full log boost; below, linear scale. Default
 *                           1 (i.e. always log-scale).
 */
export async function rerankByCitations(candidates, opts = {}) {
  await store.init();
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates;

  // Load in-corpus citation counts for every paper that appears in any
  // candidate's contributing_papers. One query, scoped to those ids.
  const allIds = new Set();
  for (const c of candidates) {
    const cp = c.contributing_papers;
    if (Array.isArray(cp)) {
      for (const id of cp) {
        if (typeof id === 'string') allIds.add(id);
        else if (id && typeof id.paper_id === 'string') allIds.add(id.paper_id);
      }
    } else if (cp && typeof cp === 'object') {
      // Some detectors (practical_gap) split into {practice, literature}.
      for (const arr of Object.values(cp)) {
        if (!Array.isArray(arr)) continue;
        for (const id of arr) if (typeof id === 'string') allIds.add(id);
      }
    }
  }

  const counts = opts.citationCountsCache || new Map();
  if (counts.size === 0 && allIds.size > 0) {
    const placeholders = [...allIds].map(() => '?').join(',');
    const rows = store.query(
      `SELECT to_paper, COUNT(*) AS n
         FROM citations
         WHERE to_paper IN (${placeholders})
         GROUP BY to_paper`,
      [...allIds],
    );
    for (const r of rows) counts.set(r.to_paper, r.n);
  }
  for (const id of allIds) if (!counts.has(id)) counts.set(id, 0);

  function paperWeight(id) {
    return 1 + Math.log(1 + (counts.get(id) || 0));
  }

  function avgWeight(c) {
    const cp = c.contributing_papers;
    const ids = [];
    if (Array.isArray(cp)) {
      for (const id of cp) {
        if (typeof id === 'string') ids.push(id);
        else if (id && typeof id.paper_id === 'string') ids.push(id.paper_id);
      }
    } else if (cp && typeof cp === 'object') {
      for (const arr of Object.values(cp)) {
        if (!Array.isArray(arr)) continue;
        for (const id of arr) if (typeof id === 'string') ids.push(id);
      }
    }
    if (ids.length === 0) return 1;
    let sum = 0;
    for (const id of ids) sum += paperWeight(id);
    return sum / ids.length;
  }

  const reranked = candidates.map((c) => {
    const multiplier = avgWeight(c);
    const orig = typeof c.salience === 'number' ? c.salience : 0;
    return {
      ...c,
      salience: orig * multiplier,
      rerank: {
        original_salience: orig,
        multiplier: Number(multiplier.toFixed(3)),
      },
    };
  });
  reranked.sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
  return reranked;
}
