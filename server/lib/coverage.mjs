// coverage.mjs
//
// Extraction coverage metrics for the v2 store. The /structured snapshot
// shows raw row counts; coverage answers "what fraction of the corpus
// has each field populated, vs unknown vs missing entirely?"
//
// Output shape:
//   {
//     corpus_size, eligible_size,
//     fields: [
//       { field: 'methodology_type', populated, unknown, missing,
//         populated_pct, unknown_pct, missing_pct },
//       ...
//     ],
//     named_entities: [{ kind, papers_with, mean_per_paper, total }],
//     results: { papers_with_results, total_rows, mean_per_paper },
//     claims:  { papers_with_claims, total_rows, with_stance, with_embedding },
//     citations: { total, classified, by_class },
//     chunks: { papers_with_chunks, total_chunks },
//   }

import * as store from './store.mjs';

const CATEGORICAL_FIELDS = [
  'methodology_type',
  'system_domain',
  'sample_type',
  'method_family',
];

const BOOL_FIELDS = [
  'claims_first_in_area',
  'challenges_existing',
  'baseline_compared',
  'releases_code',
  'reports_uncertainty',
];

export async function computeCoverage() {
  await store.init();
  const eligible = store.query(
    `SELECT paper_id FROM papers WHERE triage_label IN ('include','maybe')`,
  ).map((r) => r.paper_id);
  const eligibleSize = eligible.length;
  const corpusSize = store.query('SELECT COUNT(*) AS n FROM papers')[0]?.n || 0;

  // Three buckets per field:
  //   populated  — extracted with a real value
  //   unknown    — extractor ran but couldn't confidently classify
  //                (recorded as 'unknown' / 'false' by design)
  //   missing    — extractor never ran on this paper
  // For boolean signals 'false' is a real outcome ("checked and absent"),
  // not unknown — track separately.
  const fields = [];
  for (const f of [...CATEGORICAL_FIELDS, ...BOOL_FIELDS, 'sample_size']) {
    const isBool = BOOL_FIELDS.includes(f);
    const rows = store.query(
      `SELECT field_value
         FROM paper_field
        WHERE field_name = ?
          AND paper_id IN (SELECT paper_id FROM papers WHERE triage_label IN ('include','maybe'))`,
      [f],
    );
    let populated = 0, unknown = 0, falseSignal = 0;
    for (const r of rows) {
      const v = String(r.field_value || '').trim().toLowerCase();
      if (!v || v === 'unknown') unknown++;
      // Bool3 (new pipeline): refuted = "checked and explicitly absent",
      // counted as populated with a separate `false_signal` tally.
      else if (isBool && (v === 'refuted' || v === 'false')) { falseSignal++; populated++; }
      else populated++;
    }
    const missing = Math.max(0, eligibleSize - rows.length);
    // Reconcile percentages so populated+unknown+missing sums to 100.0
    // exactly (rounding per-bucket can otherwise drift to 99.9 / 100.1).
    const populatedPct = pct(populated, eligibleSize);
    const unknownPct = pct(unknown, eligibleSize);
    const missingPct = eligibleSize > 0
      ? Number(Math.max(0, 100 - populatedPct - unknownPct).toFixed(2))
      : 0;
    fields.push({
      field: f,
      populated,
      unknown,
      missing,
      ...(isBool ? { false_signal: falseSignal } : {}),
      populated_pct: populatedPct,
      unknown_pct:   unknownPct,
      missing_pct:   missingPct,
    });
  }

  // Multi-row entity counts. Kinds are user-defined via topic.md
  // entity_types; we read whatever has been written into name_usage so
  // coverage reflects the corpus's actual entity vocabulary rather than
  // a hardcoded CS-centric subset.
  const kindRows = store.query(
    `SELECT DISTINCT kind FROM name_usage
      WHERE paper_id IN (SELECT paper_id FROM papers WHERE triage_label IN ('include','maybe'))
      ORDER BY kind`,
  );
  const allKinds = kindRows.map((r) => r.kind).filter(Boolean);
  // Always include the universal-fallback types so the UI shows them
  // even when 0 entities have been extracted yet.
  for (const k of ['person', 'organisation', 'place', 'concept']) {
    if (!allKinds.includes(k)) allKinds.push(k);
  }
  const namedEntities = [];
  for (const kind of allKinds) {
    const r = store.query(
      `SELECT COUNT(DISTINCT paper_id) AS papers_with,
              COUNT(*) AS total,
              CAST(COUNT(*) AS REAL) / NULLIF(COUNT(DISTINCT paper_id), 0) AS mean_per_paper
         FROM name_usage
        WHERE kind = ?
          AND paper_id IN (SELECT paper_id FROM papers WHERE triage_label IN ('include','maybe'))`,
      [kind],
    )[0] || {};
    namedEntities.push({
      kind,
      papers_with: r.papers_with || 0,
      total: r.total || 0,
      mean_per_paper: r.mean_per_paper ? Number(r.mean_per_paper.toFixed(2)) : 0,
      coverage_pct: pct(r.papers_with || 0, eligibleSize),
    });
  }

  // Results, claims, citations, chunks.
  const results = store.query(
    `SELECT COUNT(DISTINCT paper_id) AS papers, COUNT(*) AS total
       FROM results
      WHERE paper_id IN (SELECT paper_id FROM papers WHERE triage_label IN ('include','maybe'))`,
  )[0] || { papers: 0, total: 0 };

  const claims = store.query(
    `SELECT COUNT(DISTINCT paper_id) AS papers,
            COUNT(*) AS total,
            SUM(CASE WHEN stance IS NOT NULL THEN 1 ELSE 0 END) AS with_stance
       FROM claims
      WHERE paper_id IN (SELECT paper_id FROM papers WHERE triage_label IN ('include','maybe'))`,
  )[0] || { papers: 0, total: 0, with_stance: 0 };

  const citations = store.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN context_class IS NOT NULL THEN 1 ELSE 0 END) AS classified
       FROM citations`,
  )[0] || { total: 0, classified: 0 };

  const byClass = store.query(
    `SELECT context_class, COUNT(*) AS n
       FROM citations
      WHERE context_class IS NOT NULL
      GROUP BY context_class`,
  );

  const chunks = store.query(
    `SELECT COUNT(DISTINCT paper_id) AS papers,
            COUNT(*) AS total
       FROM chunks
      WHERE paper_id IN (SELECT paper_id FROM papers WHERE triage_label IN ('include','maybe'))`,
  )[0] || { papers: 0, total: 0 };

  return {
    corpus_size: corpusSize,
    eligible_size: eligibleSize,
    fields,
    named_entities: namedEntities,
    results: {
      papers_with_results: results.papers,
      total_rows: results.total,
      mean_per_paper: results.papers ? Number((results.total / results.papers).toFixed(2)) : 0,
      coverage_pct: pct(results.papers, eligibleSize),
    },
    claims: {
      papers_with_claims: claims.papers,
      total_rows: claims.total,
      with_stance: claims.with_stance,
      stance_pct: pct(claims.with_stance, claims.total || 0),
      coverage_pct: pct(claims.papers, eligibleSize),
    },
    citations: {
      total: citations.total,
      classified: citations.classified,
      classified_pct: pct(citations.classified, citations.total || 0),
      by_class: byClass,
    },
    chunks: {
      papers_with_chunks: chunks.papers,
      total_chunks: chunks.total,
      coverage_pct: pct(chunks.papers, eligibleSize),
    },
  };
}

function pct(n, total) {
  if (!total) return 0;
  return Math.round((n / total) * 10000) / 100;   // two decimals
}
