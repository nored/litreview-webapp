// detectors/bibliographic_coupling.mjs
//
// Bibliographic coupling (Kessler 1963). Two papers are "coupled" if
// they share at least one cited reference. The more references they
// share, the stronger their tie. Unlike co-citation (which is a
// posterior measure — papers get co-cited *after* both exist),
// bibliographic coupling is a *prior* measure — papers couple based on
// the bibliographies they wrote, so emerging conversations show up
// immediately (no waiting for someone to co-cite them).
//
// SQL self-join, mirror of co_citation but joining on `to_paper`
// instead of `from_paper`.

import * as store from '../store.mjs';
import { pickThresholds } from './_scale.mjs';

const DEFAULT_MAX_CANDIDATES = 40;

export async function detectBibliographicCoupling(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const minStrength = opts.minStrength ?? Math.max(2, Math.round(t.minPapersPerGroup * 0.7));
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const inCorpusOnly = opts.inCorpusOnly ?? true;

  const sql = inCorpusOnly
    ? `SELECT a.from_paper AS paper_a, b.from_paper AS paper_b,
              COUNT(DISTINCT a.to_paper) AS strength,
              group_concat(DISTINCT a.to_paper) AS shared_refs
         FROM citations a
         JOIN citations b ON a.to_paper = b.to_paper AND a.from_paper < b.from_paper
         JOIN papers pa ON pa.paper_id = a.from_paper
         JOIN papers pb ON pb.paper_id = b.from_paper
        GROUP BY a.from_paper, b.from_paper
       HAVING strength >= ?
        ORDER BY strength DESC
        LIMIT ?`
    : `SELECT a.from_paper AS paper_a, b.from_paper AS paper_b,
              COUNT(DISTINCT a.to_paper) AS strength,
              group_concat(DISTINCT a.to_paper) AS shared_refs
         FROM citations a
         JOIN citations b ON a.to_paper = b.to_paper AND a.from_paper < b.from_paper
        GROUP BY a.from_paper, b.from_paper
       HAVING strength >= ?
        ORDER BY strength DESC
        LIMIT ?`;

  const rows = store.query(sql, [minStrength, maxCandidates]);
  if (rows.length === 0) {
    return { candidates: [], total_candidates: 0, reason: 'no_pairs_above_threshold' };
  }

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
    const refs = (r.shared_refs || '').split(',').filter(Boolean);
    return {
      cell: { paper_a: r.paper_a, paper_b: r.paper_b },
      statistic: {
        strength: r.strength,
        shared_reference_count: refs.length,
      },
      contributing_papers: refs,
      description: `Bibliographic coupling strength ${r.strength} — "${(ta || '').slice(0, 60)}" and "${(tb || '').slice(0, 60)}" share ${r.strength} cited reference(s). Suggests an emerging conversation drawing on the same prior literature.`,
      salience: r.strength,
    };
  });

  return { candidates, total_candidates: candidates.length };
}

export const TYPE = 'bibliographic_coupling';
