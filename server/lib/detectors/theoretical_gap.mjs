// detectors/theoretical_gap.mjs
//
// Type 6: Theoretical gap. Two sub-types, both flagged here:
//
//   ORPHAN — a category has many papers but few or no theoretical
//            frameworks cited. The phenomenon is being studied but
//            no agreed theoretical anchor explains it. Detected per
//            category as `count(papers) / max(1, count(distinct
//            frameworks_cited))` — high ratio = orphan.
//
//   DISPUTED — a category has multiple papers where the
//              `challenges_existing` flag is true. Even when
//              frameworks are cited, the corpus disputes them.
//              Detected per category as fraction of papers with
//              `challenges_existing = 'true'`. > 0.25 = disputed.
//
// Pure SQL aggregation; no claim-cluster analysis needed. (The
// claim-cluster version — "which topic clusters have no frameworks
// attributed?" — is more ambitious and can be added later as a
// secondary detector if the category-level path proves too coarse.)

import * as store from '../store.mjs';
import { pickThresholds } from './_scale.mjs';
import { readText } from '../../storage.mjs';
import { PROTOCOL_FILES } from '../../paths.mjs';
import { parseTopic } from '../topic_md.mjs';

const DEFAULT_DISPUTED_FRACTION = 0.25;

// Resolve which entity-type names count as "theoretical anchors" for this
// corpus. The detector is no longer hardcoded to kind='framework' — the
// user's topic.md can declare `theoretical_kinds:` explicitly (history
// might list 'doctrine', 'ideology'; biomedical might list 'theory',
// 'mechanism'). When the field is empty we apply a permissive heuristic:
// any kind whose name resembles framework / theory / concept / model /
// ideology / doctrine / paradigm. Last-resort fallback: every kind in
// the corpus, which degrades the detector to "orphan = category with
// few named entities of any type" — still useful, less specific.
async function resolveTheoreticalKinds(opts = {}) {
  if (Array.isArray(opts.theoreticalKinds) && opts.theoreticalKinds.length) {
    return { kinds: opts.theoreticalKinds, source: 'opts' };
  }
  // topic.md override.
  try {
    const md = await readText(PROTOCOL_FILES.topic, '');
    const topic = parseTopic(md) || {};
    if (Array.isArray(topic.theoretical_kinds) && topic.theoretical_kinds.length) {
      return { kinds: topic.theoretical_kinds, source: 'topic_md' };
    }
  } catch { /* fall through */ }
  // Heuristic over the corpus's actual kinds.
  const ANCHOR_RE = /^(framework|theory|concept|theoretical|conceptual|ideology|doctrine|paradigm|school|approach|model|principle)$|^.*_(framework|theory|concept|ideology|doctrine)$/;
  const allKinds = store.query(`SELECT DISTINCT kind FROM canonical_names`).map((r) => r.kind);
  const matching = allKinds.filter((k) => ANCHOR_RE.test(k));
  if (matching.length > 0) return { kinds: matching, source: 'heuristic' };
  return { kinds: allKinds, source: 'all_kinds_fallback' };
}

export async function detectTheoreticalGap(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const minPapersPerCat = opts.minPapersPerCat ?? t.minPapersPerGroup;
  const orphanThreshold = opts.orphanThreshold ?? t.orphanRatio;
  const disputedFraction = opts.disputedFraction ?? DEFAULT_DISPUTED_FRACTION;
  const maxCandidates = opts.maxCandidates ?? t.topK;

  const { kinds: anchorKinds, source: anchorSource } = await resolveTheoreticalKinds(opts);
  if (anchorKinds.length === 0) {
    return {
      candidates: [],
      total_candidates: 0,
      anchor_kinds: [],
      anchor_source: 'none',
      note: 'no entity kinds available for theoretical-anchor detection',
    };
  }
  const kindPlaceholders = anchorKinds.map(() => '?').join(',');

  // Per-category aggregates. The LEFT JOIN counts framework-like entities
  // cited per paper in each category.
  const rows = store.query(`
    SELECT pc.category AS category,
           COUNT(DISTINCT pc.paper_id) AS paper_count,
           COUNT(DISTINCT nu.canonical) AS framework_count,
           group_concat(DISTINCT pc.paper_id) AS papers,
           group_concat(DISTINCT nu.canonical) AS frameworks
      FROM paper_category pc
      LEFT JOIN name_usage nu
        ON nu.paper_id = pc.paper_id AND nu.kind IN (${kindPlaceholders})
     GROUP BY pc.category
  `, anchorKinds);

  // Per-category "challenges_existing" rate. The new bool_signals
  // pipeline writes field_type='bool3' with values confirmed / refuted
  // / unknown; older runs may have field_type='bool' with true / false.
  // Treat both 'true' (legacy) and 'confirmed' (current) as positive.
  const challRows = store.query(`
    SELECT pc.category AS category,
           SUM(CASE WHEN pf.field_value IN ('true', 'confirmed') THEN 1 ELSE 0 END) AS challenges_count,
           COUNT(DISTINCT pc.paper_id) AS paper_count,
           group_concat(DISTINCT CASE WHEN pf.field_value IN ('true', 'confirmed') THEN pc.paper_id END) AS challenging_papers
      FROM paper_category pc
      JOIN paper_field pf ON pf.paper_id = pc.paper_id AND pf.field_name = 'challenges_existing'
     GROUP BY pc.category
  `);
  const challByCat = new Map();
  for (const r of challRows) challByCat.set(r.category, r);

  const candidates = [];
  for (const r of rows) {
    if (r.paper_count < minPapersPerCat) continue;
    const ratio = r.paper_count / Math.max(1, r.framework_count);

    // Orphan: high paper-to-framework ratio.
    if (ratio >= orphanThreshold) {
      candidates.push({
        cell: { category: r.category, subtype: 'orphan' },
        statistic: {
          paper_count: r.paper_count,
          framework_count: r.framework_count,
          ratio: Number(ratio.toFixed(2)),
        },
        contributing_papers: (r.papers || '').split(',').filter(Boolean),
        cited_frameworks: (r.frameworks || '').split(',').filter(Boolean),
        description: `Category "${r.category}": ${r.paper_count} papers but only ${r.framework_count} distinct theoretical framework(s) cited. Phenomenon is studied without a shared theoretical anchor.`,
        salience: r.paper_count * (ratio / orphanThreshold),
      });
    }

    // Disputed: high challenges_existing fraction.
    const ch = challByCat.get(r.category);
    if (ch && ch.paper_count >= minPapersPerCat) {
      const frac = ch.challenges_count / ch.paper_count;
      if (frac >= disputedFraction) {
        candidates.push({
          cell: { category: r.category, subtype: 'disputed' },
          statistic: {
            paper_count: ch.paper_count,
            challenges_count: ch.challenges_count,
            challenges_fraction: Number(frac.toFixed(3)),
            framework_count: r.framework_count,
          },
          contributing_papers: (ch.challenging_papers || '').split(',').filter(Boolean),
          cited_frameworks: (r.frameworks || '').split(',').filter(Boolean),
          description: `Category "${r.category}": ${ch.challenges_count}/${ch.paper_count} papers (${Math.round(frac * 100)}%) explicitly challenge existing approaches in this area. Theory is disputed.`,
          salience: ch.challenges_count * frac * 10,
        });
      }
    }
  }

  candidates.sort((a, b) => b.salience - a.salience);
  return {
    candidates: candidates.slice(0, maxCandidates),
    total_candidates: candidates.length,
    anchor_kinds: anchorKinds,
    anchor_source: anchorSource,
  };
}

export const TYPE = 'theoretical';
