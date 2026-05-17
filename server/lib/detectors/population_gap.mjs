// detectors/population_gap.mjs
//
// Type 7: Population gap. A population / domain / sample-type / language
// is underrepresented relative to the rest of the corpus. We compute
// the coverage matrix over the population dimensions stored in the
// structured store and flag sparse cells whose neighbours are dense.
//
// Dimensions currently populated (M2):
//   * system_domain  — `paper_field` with field_name='system_domain'
//   * sample_type    — `paper_field` with field_name='sample_type'
//   * language, geography, time_period — `paper_population` (multi-valued
//     dimensions; currently not extracted by M2, but the schema is in
//     place and a later extractor can fill them).
//
// For M4.first-cut we look at the 2-D (system_domain × sample_type)
// table. As more population dims get populated, we add them.
//
// Pure SQL + JS tensor analysis; no LLM.

import * as store from '../store.mjs';
import { pickThresholds } from './_scale.mjs';

const DEFAULT_MAX_CANDIDATES = 50;

const SYSTEM_DOMAINS = [
  'healthcare', 'legal', 'finance', 'education',
  'software_engineering', 'manufacturing', 'transportation',
  'agriculture', 'energy', 'other',
];
const SAMPLE_TYPES = ['individual', 'organisation', 'mixed', 'n/a'];

function buildTensor() {
  const rows = store.query(`
    SELECT sd.field_value AS domain,
           st.field_value AS sample_type,
           sd.paper_id
      FROM paper_field sd
      JOIN paper_field st ON st.paper_id = sd.paper_id
                          AND st.field_name = 'sample_type'
                          AND st.field_value <> ''
                          AND st.field_value <> 'unknown'
     WHERE sd.field_name = 'system_domain'
       AND sd.field_value <> ''
       AND sd.field_value <> 'unknown'
  `);
  const tensor = new Map();
  for (const r of rows) {
    const key = `${r.domain}||${r.sample_type}`;
    if (!tensor.has(key)) tensor.set(key, new Set());
    tensor.get(key).add(r.paper_id);
  }
  return tensor;
}

function cellKey(d, s) { return `${d}||${s}`; }

function neighbours(domain, sample) {
  const out = [];
  for (const d of SYSTEM_DOMAINS) if (d !== domain) out.push([d, sample]);
  for (const s of SAMPLE_TYPES)   if (s !== sample) out.push([domain, s]);
  return out;
}

export async function detectPopulationGap(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const minNeighbourCount = opts.minNeighbourCount ?? Math.max(2, t.minClusterSize);
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const tensor = buildTensor();
  if (tensor.size === 0) {
    return { candidates: [], reason: 'no papers have system_domain × sample_type populated' };
  }

  const candidates = [];
  for (const domain of SYSTEM_DOMAINS) {
    for (const sample of SAMPLE_TYPES) {
      const count = (tensor.get(cellKey(domain, sample)) || new Set()).size;
      if (count > 0) continue;

      const nbrs = neighbours(domain, sample);
      let nbrSum = 0;
      const denseNeighbours = [];
      for (const [d, s] of nbrs) {
        const n = (tensor.get(cellKey(d, s)) || new Set()).size;
        nbrSum += n;
        if (n > 0) denseNeighbours.push({ cell: { system_domain: d, sample_type: s }, count: n });
      }
      const meanNbr = nbrs.length > 0 ? nbrSum / nbrs.length : 0;
      if (meanNbr < minNeighbourCount) continue;

      const contribIds = new Set();
      for (const nbr of denseNeighbours) {
        const key = cellKey(nbr.cell.system_domain, nbr.cell.sample_type);
        for (const pid of (tensor.get(key) || new Set())) contribIds.add(pid);
      }
      candidates.push({
        cell: { system_domain: domain, sample_type: sample },
        statistic: {
          count: 0,
          neighbour_mean: meanNbr,
          neighbour_max: Math.max(...denseNeighbours.map((n) => n.count), 0),
          n_dense_neighbours: denseNeighbours.length,
        },
        neighbour_cells: denseNeighbours.slice(0, 6),
        contributing_papers: [...contribIds],
        description:
          `No paper studies a "${sample}" sample type in the "${domain}" domain. Adjacent cells average ${meanNbr.toFixed(1)} papers.`,
        salience: meanNbr * denseNeighbours.length,
      });
    }
  }

  candidates.sort((a, b) => b.salience - a.salience);
  return {
    candidates: candidates.slice(0, maxCandidates),
    total_candidates: candidates.length,
    cells_examined: SYSTEM_DOMAINS.length * SAMPLE_TYPES.length,
  };
}

export const TYPE = 'population';
