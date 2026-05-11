// active_learning.mjs
//
// "Train the classifier" loop. Sequentially picks the single most
// informative *unlabeled* paper for the student to decide on, hides the
// system's own prediction, and lets the student's blind judgement become
// the ground-truth signal that reshapes the prototypes for the next pick.
//
// Two design rules, both load-bearing:
//
//   1. SELECT STRONG, NOT WEAK. Active-learning literature often points at
//      "most uncertain" papers (smallest margin). For this tool we go the
//      other way: papers the classifier currently scores most confidently
//      (largest |margin|), with cluster-diversity coverage so we don't
//      ask 24 variants of the same paper. Reason: confident cases produce
//      *clean* labels (the student can tell quickly which way they go),
//      and any disagreement is a high-information correction. Borderline
//      papers are ambiguous to the student too and produce noisy labels.
//
//   2. BLIND THE STUDENT. The API never exposes scores or the system's
//      predicted label in the round payload. The student decides on the
//      paper itself, not on what the system already thinks. Anchoring
//      bias defeats the point of training.
//
// Live re-weighting: every label is recorded via triage.setDecision,
// which gets the prefilter to re-read the CSV on its next computePrototypes
// call. So the next selection picks against the freshly-updated prototype
// bank — no caching, no staleness.

import * as vectors from './vectors.mjs';
import * as triage from './triage.mjs';
import { makeMatrix, normalize, communityDetection, autoTuneCommunityParams } from './sbert_utils.mjs';
import { computePrototypes } from './triage_prefilter.mjs';

const PAPERS = 'papers';

// Minimum total decisions (any path: manual / training / auto-decide) before
// the pre-filter's AI-sort actions unlock. Below this threshold the
// classifier's prototypes are too sparse to be trustworthy and we want the
// student to teach it more first.
export const MIN_DECISIONS_FOR_AI_SORT = 10;

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function bestProtoScore(rowVec, prototypes) {
  if (!prototypes.length) return -Infinity;
  let best = -Infinity;
  for (const p of prototypes) {
    const s = dot(rowVec, p.vec);
    if (s > best) best = s;
  }
  return best;
}

// Score every currently-pending paper against the current prototypes.
// Returns an array of { row_index, title, abstract, year, venue,
// _confidence (private — never sent to the client), _row_vec }.
async function scorePending() {
  const proto = await computePrototypes();
  if (!proto.include_prototypes.length || !proto.exclude_prototypes.length) {
    return { items: [], reason: 'classifier has no prototypes yet' };
  }
  const labelByIdx = proto._label_by_idx;
  const { ids, meta, matrix } = await vectors.loadMatrix(PAPERS);
  const dim = matrix.dim;
  // Encoder emits L2-normalized vectors, so dot = cosine without an
  // extra normalize pass. Saves ~50% of the scoring time on a ~1800-row
  // pending set, which matters when this runs on every user decision.
  const data = matrix.data;

  const items = [];
  for (let i = 0; i < ids.length; i++) {
    const ridx = Number.isInteger(meta[i]?.row_index) ? meta[i].row_index : Number(ids[i]);
    if (labelByIdx.get(ridx)) continue; // only pending
    const row = data.subarray(i * dim, (i + 1) * dim);
    const inc = bestProtoScore(row, proto.include_prototypes);
    const exc = bestProtoScore(row, proto.exclude_prototypes);
    items.push({
      row_index: ridx,
      title: meta[i].title || '',
      year: meta[i].year || '',
      venue: meta[i].venue || '',
      doi: meta[i].doi || '',
      _row_vec: row,
      _confidence: Math.abs(inc - exc),
    });
  }
  return { items };
}

// Pick the next cluster-center for the student to decide on. Strategy:
//   - Cluster the UNLABELED papers (not the labeled ones) using
//     communityDetection with k-NN auto-tuned parameters.
//   - Sort clusters by size descending — densest first, because the
//     densest cluster lets the student decide the most papers per click.
//   - Take the central member of the densest cluster as the centroid.
//   - Return the centroid plus the row_indices of every member of its
//     cluster. The client passes that list back with the decision and the
//     server propagates the label across all of them automatically.
//
// Singletons (pending papers that don't form a community) are appended
// after the multi-member clusters so the student eventually sees them
// too, one click at a time.
//
// `exclude` is a Set of row_indices the student has already seen this
// session (skipped). Already-labeled papers are dropped automatically via
// the live label join in computePrototypes.
export async function pickTrainingBatch({ n = 1, exclude = new Set() } = {}) {
  const { items, reason } = await scorePending();
  if (!items.length) return { items: [], reason: reason || 'no pending papers' };

  // Filter out already-skipped papers from the universe.
  const available = items.filter((it) => !exclude.has(it.row_index));
  if (!available.length) return { items: [], reason: 'no unshown pending papers remain' };

  // Cluster all pending papers — not a top-K subset. The student wants
  // to decide on whatever cluster is biggest, not whatever the classifier
  // happens to be confident about (which might be one tight neighbourhood
  // already represented in their labels).
  const dim = available[0]._row_vec.length;
  const flat = new Float32Array(available.length * dim);
  for (let i = 0; i < available.length; i++) flat.set(available[i]._row_vec, i * dim);
  const M = makeMatrix(available.length, dim, flat);
  const tuning = autoTuneCommunityParams(M, { minSize: 2 });
  const communities = communityDetection(M, {
    threshold: tuning.threshold,
    minCommunitySize: 2,
  });

  // Sort by size descending — densest cluster first, biggest leverage
  // per click.
  communities.sort((a, b) => b.length - a.length);

  // For n=1 the typical interactive case, just return the densest cluster's
  // central member + its cluster members. For n>1 (initial bulk picks)
  // return n distinct cluster centers.
  const inCommunity = new Set();
  const out = [];
  for (const group of communities) {
    if (out.length >= n) break;
    const centerIdx = group[0];
    if (inCommunity.has(centerIdx)) continue;
    for (const i of group) inCommunity.add(i);
    out.push({
      ...available[centerIdx],
      _cluster_members: group.map((gi) => available[gi].row_index),
    });
  }
  // If we don't have n yet (singletons), fill with high-confidence
  // remaining papers as 1-of-1 "clusters".
  for (let i = 0; i < available.length && out.length < n; i++) {
    if (inCommunity.has(i)) continue;
    inCommunity.add(i);
    out.push({
      ...available[i],
      _cluster_members: [available[i].row_index],
    });
  }

  return {
    items: out.map(blind),
    reason: null,
    _meta: {
      pool_size: available.length,
      communities: communities.length,
      auto_tune: tuning,
    },
  };
}

// Strip everything the client shouldn't see — scores, vectors, confidence,
// system predicted label. KEEPS cluster_members because that's not a
// system prediction; it's "here are similar papers your decision will
// also apply to", which the student needs to know before deciding.
function blind(it) {
  return {
    row_index: it.row_index,
    title: it.title,
    year: it.year,
    venue: it.venue,
    doi: it.doi,
    cluster_members: it._cluster_members || [it.row_index],
    cluster_size: (it._cluster_members || [it.row_index]).length,
  };
}

// ---------------------------------------------------------------------------
// State / gating
// ---------------------------------------------------------------------------

// Combined training step: record a decision, automatically apply confident
// pre-filter decisions in the background (once enough labels exist), then
// pick the next paper to show. One endpoint, one round-trip per click.
// Returns { applied (count), applied_titles (array), next (paper or null),
// state (training state) }.
import * as triagePrefilter from './triage_prefilter.mjs';

export async function stepTraining({
  row_index,
  label,
  reason,
  cluster_members,
  exclude = new Set(),
} = {}) {
  let cluster_applied = 0;
  let cascade_applied = 0;
  let applied_titles = [];

  // Phase 1 — record the user's decision on the centroid itself.
  const validLabel = label === 'include' || label === 'exclude' || label === 'maybe';
  if (Number.isInteger(row_index) && validLabel) {
    await triage.setDecision({ row_index, label, reason: reason || '' });

    // Phase 2 — propagate the label to every other member of the cluster
    // the centroid represents. The cluster was computed when we picked
    // this paper, so members are by definition above the auto-tuned
    // community similarity threshold to the centroid (typically ~0.80
    // cosine for thesis-scale corpora). Anything that close is a "near-
    // collision" worth inheriting the same decision.
    if (Array.isArray(cluster_members) && cluster_members.length > 1) {
      const propagatedReason = `cluster propagation from row ${row_index}` +
        (reason ? ` (reason: ${reason})` : '');
      for (const mi of cluster_members) {
        if (mi === row_index) continue;
        try {
          // setDecision skips silently if the row is out of range; we
          // also skip rows that already have a label (the student may
          // have decided one manually between picks).
          const all = await triage.getAll();
          const row = all.find((r) => r.row_index === mi);
          if (!row || (row.triage_label && row.triage_label !== '')) continue;
          await triage.setDecision({ row_index: mi, label, reason: propagatedReason });
          cluster_applied++;
        } catch {
          /* per-row failures shouldn't break the whole step */
        }
      }
    }
  }

  // Phase 3 — cross-cluster cascade. Once unlocked, every training
  // decision triggers pre-filter auto-apply on whatever is now confidently
  // classifiable beyond the immediate cluster.
  const state = await trainingState();
  if (state.ai_sort_unlocked) {
    const preview = await triagePrefilter.previewDecisions();
    if (preview.ok && preview.proposed.length > 0) {
      const result = await triagePrefilter.applyDecisions(preview.proposed);
      cascade_applied = result.applied || 0;
      applied_titles = preview.proposed.slice(0, 5).map((p) => ({
        title: p.title,
        decision: p.decision,
      }));
    }
  }

  // Phase 4 — pick the next cluster centroid against the fully-updated
  // pending set (post-propagation + post-cascade).
  const next = await pickTrainingBatch({ n: 1, exclude });

  const finalState = await trainingState();

  return {
    cluster_applied,
    cascade_applied,
    // Aggregate so the UI can show one number.
    applied: cluster_applied + cascade_applied,
    applied_titles,
    next: (next.items || [])[0] || null,
    next_reason: next.reason,
    state: finalState,
  };
}

// How many decisions has the student made overall? Drives the unlock for
// AI auto-sort buttons. Counts manual + auto-applied + training-loop
// decisions — anything that ended up as a non-empty triage_label.
export async function trainingState() {
  const rows = await triage.getAll();
  let include = 0, exclude = 0, maybe = 0;
  for (const r of rows) {
    if (r.triage_label === 'include') include++;
    else if (r.triage_label === 'exclude') exclude++;
    else if (r.triage_label === 'maybe') maybe++;
  }
  const decided = include + exclude + maybe;
  return {
    decided,
    include,
    exclude,
    maybe,
    pending: rows.length - decided,
    ai_sort_unlocked: include > 0 && exclude > 0 && decided >= MIN_DECISIONS_FOR_AI_SORT,
    min_required: MIN_DECISIONS_FOR_AI_SORT,
  };
}
