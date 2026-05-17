// detectors/methodological_gap.mjs
//
// Type 4: Methodological gap. The same problem (category) has been
// approached with method A across many papers; no paper has tried
// method B on it. Empty cell in the (category × method_family) matrix
// where the *row marginal* (papers in this category, any method) is
// substantial — meaning the absence isn't just "no one's interested in
// the category".
//
// Pure SQL over the structured store; no LLM at this layer.
//
// Returns ranked candidates:
//   [{
//     cell: { category, method_family },
//     statistic: { count, row_total, col_total, n_categories, n_methods },
//     contributing_papers: { row: [paper_id,...], col: [paper_id,...] },
//     description, salience
//   }, ...]
//
// `salience` is row_total normalised — the more papers in a category
// that *aren't* using this method, the more interesting its absence.

import * as store from '../store.mjs';
import { readText } from '../../storage.mjs';
import { PROTOCOL_FILES } from '../../paths.mjs';
import { parseTopic } from '../topic_md.mjs';
import { pickThresholds } from './_scale.mjs';

async function loadAxes() {
  const md = await readText(PROTOCOL_FILES.topic, '');
  const topic = parseTopic(md) || {};
  const categories = (topic.categories || []).filter(Boolean);
  let methods = (topic.method_families || []).filter(Boolean);
  if (!methods.includes('other')) methods = [...methods, 'other'];
  return { categories, methods };
}

export async function detectMethodologicalGap(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const minRowTotal = opts.minRowTotal ?? t.minRowTotal;
  const maxCandidates = opts.maxCandidates ?? t.topK;

  const { categories, methods } = await loadAxes();
  if (categories.length === 0 || methods.length === 0) {
    return { candidates: [], reason: 'topic.md missing categories or method_families' };
  }

  // Get the populated cells: each row is (category, method_family,
  // contributing_papers). NOT NULL filters keep papers that have BOTH
  // axes extracted.
  const populated = store.query(`
    SELECT pc.category AS cat, pf.field_value AS method, pc.paper_id
      FROM paper_category pc
      JOIN paper_field pf ON pf.paper_id = pc.paper_id
                          AND pf.field_name = 'method_family'
                          AND pf.field_value <> ''
  `);

  // Build the cell counts + per-cell contributing paper sets.
  const cellPapers = new Map();    // "cat||method" → Set<paper_id>
  const rowPapers = new Map();     // cat → Set<paper_id>
  const colPapers = new Map();     // method → Set<paper_id>
  for (const row of populated) {
    const key = row.cat + '||' + row.method;
    if (!cellPapers.has(key)) cellPapers.set(key, new Set());
    cellPapers.get(key).add(row.paper_id);
    if (!rowPapers.has(row.cat)) rowPapers.set(row.cat, new Set());
    rowPapers.get(row.cat).add(row.paper_id);
    if (!colPapers.has(row.method)) colPapers.set(row.method, new Set());
    colPapers.get(row.method).add(row.paper_id);
  }

  // Enumerate every cell of the topic's full Cartesian product. Empty
  // cells with row_total >= threshold become candidates.
  const candidates = [];
  for (const cat of categories) {
    const rowSet = rowPapers.get(cat) || new Set();
    const rowTotal = rowSet.size;
    if (rowTotal < minRowTotal) continue;
    for (const method of methods) {
      const cellKey = cat + '||' + method;
      const cellCount = (cellPapers.get(cellKey) || new Set()).size;
      if (cellCount > 0) continue;  // not empty
      const colSet = colPapers.get(method) || new Set();
      const colTotal = colSet.size;
      candidates.push({
        cell: { category: cat, method_family: method },
        statistic: {
          count: 0,
          row_total: rowTotal,
          col_total: colTotal,
          n_categories: categories.length,
          n_methods: methods.length,
        },
        contributing_papers: {
          row: [...rowSet],
          col: [...colSet],
        },
        description: `No paper in category "${cat}" uses method "${method}" (${rowTotal} papers in the category overall; ${colTotal} papers use this method in other categories).`,
        salience: rowTotal * Math.max(1, colTotal),
      });
    }
  }

  candidates.sort((a, b) => b.salience - a.salience);
  return {
    candidates: candidates.slice(0, maxCandidates),
    total_candidates: candidates.length,
    cells_examined: categories.length * methods.length,
  };
}

export const TYPE = 'methodological';
