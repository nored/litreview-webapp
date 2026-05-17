// detectors/temporal_trends.mjs
//
// Year-by-year publication trends per category, method_family, framework,
// and dataset. Surfaces three temporal patterns:
//
//   EMERGING   — > recentFraction of an axis-value's papers appeared in
//                the recentWindow most recent years (e.g. > 60% of papers
//                are from the last 2 years). Suggests a growth area.
//
//   DECLINING  — < (1 - recentFraction) of papers are recent; bulk of
//                literature is older. Indicates an area where activity
//                has shifted away. (NOT necessarily an "abandoned" area
//                — the field may have moved on intentionally.)
//
//   ACCELERATING — papers-per-year is monotonically increasing across
//                  the last 3 measurable years.
//
// Pure SQL aggregation; no clustering / LLM.

import * as store from '../store.mjs';
import { pickThresholds } from './_scale.mjs';

const DEFAULT_RECENT_WINDOW_YEARS = 2;
const DEFAULT_EMERGING_FRACTION = 0.6;
const DEFAULT_DECLINING_FRACTION = 0.6;
const DEFAULT_MAX_CANDIDATES = 40;

function currentYear() { return new Date().getUTCFullYear(); }

function buildCounts(rows) {
  // rows: [{ axis_value, year, paper_id }] for one axis
  // → Map<axis_value, { totals, byYear: Map<year, count>, papers: Set }>
  const out = new Map();
  for (const r of rows) {
    if (!r.year) continue;
    if (!out.has(r.axis_value)) out.set(r.axis_value, { totals: 0, byYear: new Map(), papers: new Set() });
    const e = out.get(r.axis_value);
    e.byYear.set(r.year, (e.byYear.get(r.year) || 0) + 1);
    e.papers.add(r.paper_id);
  }
  for (const e of out.values()) e.totals = e.papers.size;
  return out;
}

function classify(entry, opts) {
  const { recentWindow, emergingFrac, decliningFrac, currentY } = opts;
  const total = entry.totals;
  let recent = 0;
  const yearList = [...entry.byYear.entries()].sort((a, b) => a[0] - b[0]);
  for (const [y, c] of yearList) if (y >= currentY - recentWindow + 1) recent += c;
  const recentFrac = total > 0 ? recent / total : 0;
  // Acceleration: last 3 years monotone increasing.
  const lastN = yearList.slice(-3);
  let accelerating = false;
  if (lastN.length >= 3) {
    accelerating = lastN[2][1] > lastN[1][1] && lastN[1][1] > lastN[0][1];
  }
  const isEmerging = total >= 4 && recentFrac >= emergingFrac;
  const isDeclining = total >= 4 && (1 - recentFrac) >= decliningFrac && !isEmerging;
  return { recentFrac, accelerating, isEmerging, isDeclining, total, yearList, recent };
}

async function detectAxis(axis, opts) {
  const t = pickThresholds();
  const recentWindow = opts.recentWindow ?? DEFAULT_RECENT_WINDOW_YEARS;
  const emergingFrac = opts.emergingFrac ?? DEFAULT_EMERGING_FRACTION;
  const decliningFrac = opts.decliningFrac ?? DEFAULT_DECLINING_FRACTION;
  const minTotal = opts.minTotal ?? Math.max(2, t.minPapersPerGroup);
  const currentY = opts.currentYear ?? currentYear();

  let rows;
  if (axis === 'category') {
    rows = store.query(`
      SELECT pc.category AS axis_value, p.year, p.paper_id
        FROM paper_category pc
        JOIN papers p ON p.paper_id = pc.paper_id
       WHERE p.year IS NOT NULL
    `);
  } else if (axis === 'method_family') {
    rows = store.query(`
      SELECT pf.field_value AS axis_value, p.year, p.paper_id
        FROM paper_field pf
        JOIN papers p ON p.paper_id = pf.paper_id
       WHERE pf.field_name = 'method_family'
         AND pf.field_value <> ''
         AND p.year IS NOT NULL
    `);
  } else {
    // Any other axis value is treated as a name_usage kind. The corpus's
    // entity_types are user-defined per topic.md, so we accept whichever
    // kind label the caller asked for. Returns empty if no rows match —
    // not an error, just a quiet "this kind is not represented yet".
    rows = store.query(`
      SELECT nu.canonical AS axis_value, p.year, p.paper_id
        FROM name_usage nu
        JOIN papers p ON p.paper_id = nu.paper_id
       WHERE nu.kind = ?
         AND p.year IS NOT NULL
    `, [axis]);
  }

  const counts = buildCounts(rows);
  const out = [];
  for (const [value, entry] of counts) {
    if (entry.totals < minTotal) continue;
    const cls = classify(entry, { recentWindow, emergingFrac, decliningFrac, currentY });
    if (!cls.isEmerging && !cls.isDeclining && !cls.accelerating) continue;
    const subtype = cls.isEmerging ? 'emerging' : (cls.isDeclining ? 'declining' : 'accelerating');
    out.push({
      cell: { axis, value, subtype },
      statistic: {
        total: cls.total,
        recent_window_years: recentWindow,
        recent_papers: cls.recent,
        recent_fraction: Number(cls.recentFrac.toFixed(3)),
        accelerating: cls.accelerating,
        year_series: cls.yearList,
      },
      contributing_papers: [...entry.papers],
      description:
        subtype === 'emerging'
          ? `Emerging area: ${cls.total} papers in "${value}" (${axis}); ${cls.recent} (${Math.round(cls.recentFrac * 100)}%) from the last ${recentWindow} years.`
        : subtype === 'declining'
          ? `Declining area: ${cls.total} papers in "${value}" (${axis}); only ${cls.recent} from the last ${recentWindow} years — the field has shifted attention elsewhere.`
        :   `Accelerating: ${cls.total} papers in "${value}" (${axis}); year-over-year counts strictly increasing over the last 3 years.`,
      salience: cls.total * (subtype === 'emerging' ? 1.5 : (subtype === 'accelerating' ? 1.2 : 1)),
    });
  }
  return out;
}

export async function detectTemporalTrends(opts = {}) {
  await store.init();
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  // Default axes: structural ones (category, method_family) plus every
  // entity-kind actually present in name_usage. This adapts to user-
  // defined entity_types without hardcoding tech/dataset/framework.
  let axes;
  if (opts.axes && opts.axes.length) {
    axes = opts.axes;
  } else {
    const kinds = store.query(`SELECT DISTINCT kind FROM name_usage ORDER BY kind`).map((r) => r.kind);
    axes = ['category', 'method_family', ...kinds];
  }

  const all = [];
  for (const axis of axes) {
    try { all.push(...await detectAxis(axis, opts)); }
    catch (e) { console.warn(`temporal_trends ${axis}: ${e?.message || e}`); }
  }
  all.sort((a, b) => b.salience - a.salience);
  return {
    candidates: all.slice(0, maxCandidates),
    total_candidates: all.length,
  };
}

export const TYPE = 'temporal_trends';
