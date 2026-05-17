// detectors/knowledge_gap.mjs
//
// Type 2: Knowledge gap (tensor path). Higher-dimensional sparsity over
// the structured coverage map: empty cells in (category × method_family
// × system_domain) where Hamming-1 neighbours are dense (i.e., changing
// one axis turns the cell from empty to populated).
//
// Salience = mean count of Hamming-1 neighbour cells. Cells next to a
// dense region matter more than cells in a barren region (which usually
// just means "out of scope").
//
// Three dimensions chosen because they're the most reliably populated
// today (category from topic.md, method_family from topic.md,
// system_domain from M2.4 categorical extraction). Higher-dim variants
// (adding sample_type, time-window etc.) can extend this module later.
//
// Pure SQL + JS tensor walk; no LLM, no embedding-based clustering.
// (The claim-cluster path to "topic-shaped" knowledge gaps lives in a
// separate detector that runs cluster analysis over claim embeddings.)

import * as store from '../store.mjs';
import { readText } from '../../storage.mjs';
import { PROTOCOL_FILES } from '../../paths.mjs';
import { parseTopic } from '../topic_md.mjs';
import { pickThresholds } from './_scale.mjs';

const DEFAULT_MAX_CANDIDATES = 50;

// system_domain enum mirrors the one in extractors/categorical.mjs.
const SYSTEM_DOMAINS = [
  'healthcare', 'legal', 'finance', 'education',
  'software_engineering', 'manufacturing', 'transportation',
  'agriculture', 'energy', 'other',
];

async function loadAxes() {
  const md = await readText(PROTOCOL_FILES.topic, '');
  const topic = parseTopic(md) || {};
  const categories = (topic.categories || []).filter(Boolean);
  let methods = (topic.method_families || []).filter(Boolean);
  if (!methods.includes('other')) methods = [...methods, 'other'];
  return { categories, methods, domains: SYSTEM_DOMAINS };
}

// Build the 3-D count tensor as a Map keyed by "cat||method||domain".
function buildTensor() {
  const rows = store.query(`
    SELECT pc.category AS cat,
           mf.field_value AS method,
           sd.field_value AS domain,
           pc.paper_id
      FROM paper_category pc
      JOIN paper_field mf ON mf.paper_id = pc.paper_id
                          AND mf.field_name = 'method_family'
                          AND mf.field_value <> ''
      JOIN paper_field sd ON sd.paper_id = pc.paper_id
                          AND sd.field_name = 'system_domain'
                          AND sd.field_value <> ''
                          AND sd.field_value <> 'unknown'
  `);
  const tensor = new Map();
  for (const r of rows) {
    const key = `${r.cat}||${r.method}||${r.domain}`;
    if (!tensor.has(key)) tensor.set(key, new Set());
    tensor.get(key).add(r.paper_id);
  }
  return tensor;
}

function cellKey(cat, method, domain) {
  return `${cat}||${method}||${domain}`;
}

function neighbours(cat, method, domain, axes) {
  const out = [];
  for (const c of axes.categories) if (c !== cat) out.push([c, method, domain]);
  for (const m of axes.methods)    if (m !== method) out.push([cat, m, domain]);
  for (const d of axes.domains)    if (d !== domain) out.push([cat, method, d]);
  return out;
}

export async function detectKnowledgeGap(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const minNeighbourCount = opts.minNeighbourCount ?? Math.max(2, t.minClusterSize);
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const axes = await loadAxes();
  if (axes.categories.length === 0 || axes.methods.length === 0) {
    return { candidates: [], reason: 'topic.md missing categories or method_families' };
  }

  const tensor = buildTensor();
  if (tensor.size === 0) {
    return { candidates: [], reason: 'no papers have category × method × system_domain populated' };
  }

  const candidates = [];
  const cellsExamined = axes.categories.length * axes.methods.length * axes.domains.length;

  for (const cat of axes.categories) {
    for (const method of axes.methods) {
      for (const domain of axes.domains) {
        const key = cellKey(cat, method, domain);
        const count = (tensor.get(key) || new Set()).size;
        if (count > 0) continue;

        // Compute mean Hamming-1 neighbour density.
        const nbrs = neighbours(cat, method, domain, axes);
        let nbrSum = 0;
        const denseNeighbours = [];
        for (const [c, m, d] of nbrs) {
          const n = (tensor.get(cellKey(c, m, d)) || new Set()).size;
          nbrSum += n;
          if (n > 0) denseNeighbours.push({ cell: { category: c, method_family: m, system_domain: d }, count: n });
        }
        const meanNbr = nbrs.length > 0 ? nbrSum / nbrs.length : 0;
        if (meanNbr < minNeighbourCount) continue;

        // Contributing papers = the union of papers in the dense neighbours.
        const contribIds = new Set();
        for (const nbr of denseNeighbours) {
          const key2 = cellKey(nbr.cell.category, nbr.cell.method_family, nbr.cell.system_domain);
          for (const pid of (tensor.get(key2) || new Set())) contribIds.add(pid);
        }

        candidates.push({
          cell: { category: cat, method_family: method, system_domain: domain },
          statistic: {
            count: 0,
            neighbour_mean: meanNbr,
            neighbour_max: Math.max(...denseNeighbours.map((n) => n.count), 0),
            n_dense_neighbours: denseNeighbours.length,
            of_total_neighbours: nbrs.length,
          },
          neighbour_cells: denseNeighbours.slice(0, 6),
          contributing_papers: [...contribIds],
          description:
            `Empty cell (${cat} × ${method} × ${domain}). Neighbours along one axis have on average ${meanNbr.toFixed(1)} papers — the corpus has explored adjacent regions but not this exact intersection.`,
          salience: meanNbr * denseNeighbours.length,
        });
      }
    }
  }

  candidates.sort((a, b) => b.salience - a.salience);
  return {
    candidates: candidates.slice(0, maxCandidates),
    total_candidates: candidates.length,
    cells_examined: cellsExamined,
  };
}

export const TYPE = 'knowledge';
