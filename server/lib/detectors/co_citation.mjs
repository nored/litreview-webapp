// detectors/co_citation.mjs
//
// Co-citation analysis (Small 1973). Two papers are "co-cited" if a
// third paper cites both. The more papers that co-cite them, the
// stronger the co-citation tie — these pairs form the implicit
// "schools of thought" or "shared intellectual lineage" of a field.
//
// One self-join on the citations table:
//
//   SELECT a.to_paper, b.to_paper, COUNT(DISTINCT a.from_paper) AS strength
//     FROM citations a
//     JOIN citations b ON a.from_paper = b.from_paper
//                      AND a.to_paper < b.to_paper
//    GROUP BY a.to_paper, b.to_paper
//   HAVING strength >= minStrength
//
// Pure SQL. No LLM. No clustering.

import * as store from '../store.mjs';
import { pickThresholds } from './_scale.mjs';

const DEFAULT_MAX_CANDIDATES = 40;

export async function detectCoCitation(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const minStrength = opts.minStrength ?? Math.max(2, Math.round(t.minPapersPerGroup * 0.7));
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const inCorpusOnly = opts.inCorpusOnly ?? true;

  // Self-join. Optionally filter to in-corpus paper pairs (the ones the
  // student can actually click into).
  const sql = inCorpusOnly
    ? `SELECT a.to_paper AS paper_a, b.to_paper AS paper_b,
              COUNT(DISTINCT a.from_paper) AS strength,
              group_concat(DISTINCT a.from_paper) AS co_citers
         FROM citations a
         JOIN citations b ON a.from_paper = b.from_paper AND a.to_paper < b.to_paper
         JOIN papers pa ON pa.paper_id = a.to_paper
         JOIN papers pb ON pb.paper_id = b.to_paper
        GROUP BY a.to_paper, b.to_paper
       HAVING strength >= ?
        ORDER BY strength DESC
        LIMIT ?`
    : `SELECT a.to_paper AS paper_a, b.to_paper AS paper_b,
              COUNT(DISTINCT a.from_paper) AS strength,
              group_concat(DISTINCT a.from_paper) AS co_citers
         FROM citations a
         JOIN citations b ON a.from_paper = b.from_paper AND a.to_paper < b.to_paper
        GROUP BY a.to_paper, b.to_paper
       HAVING strength >= ?
        ORDER BY strength DESC
        LIMIT ?`;

  const rows = store.query(sql, [minStrength, maxCandidates]);
  if (rows.length === 0) {
    return { candidates: [], total_candidates: 0, reason: 'no_pairs_above_threshold' };
  }

  // Attach paper titles for readable output.
  const paperIds = [...new Set(rows.flatMap((r) => [r.paper_a, r.paper_b]))];
  const titleRows = paperIds.length > 0
    ? store.query(
        `SELECT paper_id, title, year FROM papers WHERE paper_id IN (${paperIds.map(() => '?').join(',')})`,
        paperIds,
      )
    : [];
  const titles = new Map(titleRows.map((r) => [r.paper_id, r]));

  const candidates = rows.map((r) => {
    const ta = titles.get(r.paper_a)?.title || r.paper_a;
    const tb = titles.get(r.paper_b)?.title || r.paper_b;
    const coCiters = (r.co_citers || '').split(',').filter(Boolean);
    return {
      cell: { paper_a: r.paper_a, paper_b: r.paper_b },
      statistic: {
        strength: r.strength,
        co_citer_count: coCiters.length,
      },
      contributing_papers: coCiters,
      description: `Co-cited ${r.strength}× — "${(ta || '').slice(0, 60)}" and "${(tb || '').slice(0, 60)}" appear together in ${r.strength} citing paper(s). Suggests a shared intellectual lineage.`,
      salience: r.strength,
    };
  });

  return { candidates, total_candidates: candidates.length };
}

export const TYPE = 'co_citation';
