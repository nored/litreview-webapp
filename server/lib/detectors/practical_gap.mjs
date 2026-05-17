// detectors/practical_gap.mjs
//
// Type 3: Practical-Knowledge gap. Papers from "practice-evidence"
// methodologies (survey, observational, case study) and "literature-
// recommendation" methodologies (experimental, theoretical, formal,
// review) co-exist in the same topic cluster — but their stances on
// the claims disagree. Practitioners report doing X; the literature
// argues for Y. The disagreement IS the gap.
//
// Algorithm:
//
//   1. Build claim clusters.
//   2. For each cluster, partition members by paper.methodology_type:
//        practice_evidence  ∈ {survey, observational, case_study}
//        literature_rec    ∈ {experimental, theoretical, formal, review}
//   3. A cluster is flagged when:
//        - both partitions are present (≥1 paper each), AND
//        - their stance distributions disagree (different argmax stance),
//          OR
//        - one partition has 'challenges' / 'extends' stance majority
//          while the other has 'asserts' / 'validates' majority.
//   4. Salience = min(|practice|, |literature|) — both sides must be
//      represented for the gap to be real; the binding constraint is
//      the smaller side.

import * as store from '../store.mjs';
import { buildClusters, clusterSummary } from './_claim_clusters.mjs';
import { pickThresholds } from './_scale.mjs';

const PRACTICE_EVIDENCE = new Set(['survey', 'observational', 'case_study']);
const LITERATURE_REC = new Set(['experimental', 'theoretical', 'formal', 'review']);
const ASSERTIVE_STANCES = new Set(['asserts', 'validates']);
const CRITICAL_STANCES = new Set(['challenges', 'extends', 'theorises']);

const DEFAULT_MIN_PER_SIDE = 1;
const DEFAULT_MAX_CANDIDATES = 25;

function modeStance(claims) {
  const counts = new Map();
  for (const c of claims) {
    const s = String(c.stance || '').toLowerCase();
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let mode = null, modeCount = 0;
  for (const [s, n] of counts) if (n > modeCount) { mode = s; modeCount = n; }
  return { mode, mode_count: modeCount, distribution: Object.fromEntries(counts) };
}

export async function detectPracticalGap(opts = {}) {
  await store.init();
  const t = pickThresholds();
  const minPerSide = opts.minPerSide ?? Math.max(1, Math.round(t.minClusterSize / 2));
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const clusterIndex = opts.clusters ?? await buildClusters(opts);
  if (!clusterIndex.clusters || clusterIndex.clusters.length === 0) {
    return {
      candidates: [], total_candidates: 0,
      reason: clusterIndex.reason || 'no_claim_clusters',
    };
  }

  const candidates = [];
  for (const cluster of clusterIndex.clusters) {
    const practice = [];
    const literature = [];
    for (const m of cluster.members) {
      const mt = String(m.methodology_type || '').toLowerCase();
      if (PRACTICE_EVIDENCE.has(mt)) practice.push(m);
      else if (LITERATURE_REC.has(mt)) literature.push(m);
    }
    if (practice.length < minPerSide || literature.length < minPerSide) continue;

    const pStance = modeStance(practice);
    const lStance = modeStance(literature);

    // Disagreement criteria:
    //   (a) different modal stance between sides, OR
    //   (b) one side critical-majority while the other is assertive-majority
    const stanceDiffer = pStance.mode && lStance.mode && pStance.mode !== lStance.mode;
    const pCritical = pStance.mode && CRITICAL_STANCES.has(pStance.mode);
    const lAssertive = lStance.mode && ASSERTIVE_STANCES.has(lStance.mode);
    const pAssertive = pStance.mode && ASSERTIVE_STANCES.has(pStance.mode);
    const lCritical = lStance.mode && CRITICAL_STANCES.has(lStance.mode);
    const sidedMismatch = (pCritical && lAssertive) || (pAssertive && lCritical);
    if (!stanceDiffer && !sidedMismatch) continue;

    const practicePapers = new Set(practice.map((m) => m.paper_id));
    const literaturePapers = new Set(literature.map((m) => m.paper_id));

    candidates.push({
      cell: { cluster_id: cluster.id },
      statistic: {
        practice_claims: practice.length,
        literature_claims: literature.length,
        practice_papers: practicePapers.size,
        literature_papers: literaturePapers.size,
        practice_mode_stance: pStance.mode,
        literature_mode_stance: lStance.mode,
        practice_stance_distribution: pStance.distribution,
        literature_stance_distribution: lStance.distribution,
      },
      contributing_papers: {
        practice: [...practicePapers],
        literature: [...literaturePapers],
      },
      example_quotes: {
        practice: practice.slice(0, 2).map((m) => ({ paper_id: m.paper_id, text: m.text, page: m.page })),
        literature: literature.slice(0, 2).map((m) => ({ paper_id: m.paper_id, text: m.text, page: m.page })),
      },
      description: `Survey/observational papers (mode: ${pStance.mode}) disagree with experimental/theoretical papers (mode: ${lStance.mode}) on this topic. ${clusterSummary(cluster)}`,
      salience: Math.min(practicePapers.size, literaturePapers.size) * Math.max(practice.length, literature.length),
    });
  }

  candidates.sort((a, b) => b.salience - a.salience);
  return {
    candidates: candidates.slice(0, maxCandidates),
    total_candidates: candidates.length,
    clustering_params: clusterIndex.params,
  };
}

export const TYPE = 'practical';
