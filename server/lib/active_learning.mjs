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
import * as downloadDaemon from './download_daemon.mjs';
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
//
// Cold start: when one or both prototype sets are empty, we DON'T bail
// out — the trainer is supposed to bootstrap from zero labels. We
// return every pending paper with _confidence=0; pickTrainingBatch
// clusters them and picks the densest cluster's centroid, which is
// exactly the right cold-start strategy.
async function scorePending() {
  const proto = await computePrototypes();
  const labelByIdx = proto._label_by_idx;
  const { ids, meta, matrix } = await vectors.loadMatrix(PAPERS);
  if (!ids?.length) {
    return { items: [], reason: 'no embedded papers, embed daemon may still be running' };
  }
  // Bound row_index to the CURRENT CSV. Vector-store entries from a
  // previous (larger) corpus have row_index values that no longer
  // resolve to a row, which previously caused setDecision to silently
  // drop the decision and the picker to re-pick the same paper forever.
  const csvSize = labelByIdx.size;
  const dim = matrix.dim;
  const data = matrix.data;
  const hasIncludeProto = proto.include_prototypes.length > 0;
  const hasExcludeProto = proto.exclude_prototypes.length > 0;
  const coldStart = !hasIncludeProto || !hasExcludeProto;

  const items = [];
  for (let i = 0; i < ids.length; i++) {
    const ridx = Number.isInteger(meta[i]?.row_index) ? meta[i].row_index : Number(ids[i]);
    if (!Number.isInteger(ridx) || ridx < 0 || ridx >= csvSize) continue;   // stale vector entry
    if (labelByIdx.get(ridx)) continue; // only pending
    const row = data.subarray(i * dim, (i + 1) * dim);
    let confidence = 0;
    if (!coldStart) {
      const inc = bestProtoScore(row, proto.include_prototypes);
      const exc = bestProtoScore(row, proto.exclude_prototypes);
      confidence = Math.abs(inc - exc);
    }
    items.push({
      row_index: ridx,
      title: meta[i].title || '',
      year: meta[i].year || '',
      venue: meta[i].venue || '',
      doi: meta[i].doi || '',
      _row_vec: row,
      _confidence: confidence,
    });
  }
  return { items, cold_start: coldStart };
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

  // The cached corpus profile holds community structure computed ONCE
  // post-search. Communities don't change as the user labels papers —
  // they're a property of the embeddings, not the labels. So we walk
  // the cached communities, filter out labeled/skipped/excluded rows,
  // and pick the densest still-pending community's centroid. No
  // re-running community_detection per click.
  let profile = getCorpusProfile();
  if (!profile) {
    // Lazy fill on first pick if the post-search hook hasn't run.
    profile = await computeCorpusProfile();
  }
  if (!profile) {
    return { items: [], reason: 'corpus profile not available; embedder may still be running' };
  }

  // Build a row_index → pending-item map for fast lookup.
  const pendingByRowIndex = new Map();
  for (const it of items) {
    if (exclude.has(it.row_index)) continue;
    pendingByRowIndex.set(it.row_index, it);
  }
  if (pendingByRowIndex.size === 0) {
    return { items: [], reason: 'no unshown pending papers remain' };
  }

  // Map cached community indexes (over the FULL corpus matrix) to
  // pending row_indexes. profile.meta is parallel to profile.matrix;
  // a community member at matrix index i maps to meta[i].row_index.
  const tuning = profile.tuning;
  const propagationThreshold = profile.propagation_threshold;
  const PROPAGATION_CAP = 8;
  const out = [];
  const consumed = new Set();

  for (const group of profile.communities) {
    if (out.length >= n) break;
    // Restrict the community to its still-pending members.
    const pendingMembers = group.filter((mi) => {
      const ri = profile.meta[mi]?.row_index ?? Number(profile.ids[mi]);
      return pendingByRowIndex.has(ri) && !consumed.has(ri);
    });
    if (pendingMembers.length === 0) continue;
    const centerMi = pendingMembers[0];
    const centerRi = profile.meta[centerMi]?.row_index ?? Number(profile.ids[centerMi]);
    const centerItem = pendingByRowIndex.get(centerRi);
    consumed.add(centerRi);
    // Strict near-duplicate propagation, using the corpus matrix's
    // already-normalized vectors.
    const propagable = [centerRi];
    const dim = profile.matrix.dim;
    const offC = centerMi * dim;
    for (const mi of pendingMembers) {
      if (mi === centerMi) continue;
      const ri = profile.meta[mi]?.row_index ?? Number(profile.ids[mi]);
      if (consumed.has(ri)) continue;
      let sim = 0;
      const offM = mi * dim;
      for (let d = 0; d < dim; d++) sim += profile.matrix.data[offC + d] * profile.matrix.data[offM + d];
      if (sim >= propagationThreshold) {
        propagable.push(ri);
        consumed.add(ri);
      }
      if (propagable.length >= PROPAGATION_CAP) break;
    }
    out.push({
      ...centerItem,
      _cluster_members: propagable,
      _community_size: pendingMembers.length,
      _community_threshold: tuning.threshold,
      _propagation_threshold: propagationThreshold,
    });
  }

  // Singletons (pending papers that weren't in any community).
  for (const [ri, item] of pendingByRowIndex) {
    if (out.length >= n) break;
    if (consumed.has(ri)) continue;
    consumed.add(ri);
    out.push({
      ...item,
      _cluster_members: [ri],
      _community_size: 1,
    });
  }

  return {
    items: out.map(blind),
    reason: null,
    _meta: {
      pool_size: pendingByRowIndex.size,
      communities: profile.communities.length,
      auto_tune: tuning,
      profile_computed_at: profile.computed_at,
      used_cached_profile: true,
    },
  };
}

// Strip everything the client shouldn't see — scores, vectors, confidence,
// system predicted label. KEEPS cluster_members because that's not a
// system prediction; it's "here are similar papers your decision will
// also apply to", which the student needs to know before deciding.
function blind(it) {
  const members = it._cluster_members || [it.row_index];
  return {
    row_index: it.row_index,
    title: it.title,
    year: it.year,
    venue: it.venue,
    doi: it.doi,
    cluster_members: members,
    cluster_size: members.length,        // strict near-dups (propagation set)
    community_size: it._community_size ?? members.length,  // full thematic cluster
    community_threshold: it._community_threshold,
    propagation_threshold: it._propagation_threshold,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Corpus-profile cache. This is the WHOLE point of "compute once after
// search, reuse for every pick": community detection over a 1000+-paper
// matrix takes 5-10 seconds; running it on every help-me-triage click
// is the wrong shape. The cache holds:
//
//   matrix     — normalized vectors, ready for dot products
//   meta       — parallel array of {row_index, paper_id, title, ...}
//   tuning     — autoTuneCommunityParams output (threshold, k_used, ...)
//   communities — communityDetection output (Array<row-index lists>)
//   distribution — pairwise cosine percentiles + histogram
//   propagation_threshold — data-driven (99th percentile of cosines)
//
// Cache invalidates when paper count changes. Triggered post-search by
// the embed-daemon idle subscriber; the picker also fills it lazily.
// ─────────────────────────────────────────────────────────────────────
let _corpusProfile = null;

export function getCorpusProfile() { return _corpusProfile; }
export function invalidateCorpusProfile() { _corpusProfile = null; }

export async function computeCorpusProfile({ force = false } = {}) {
  if (!force && _corpusProfile) return _corpusProfile;
  const { ids, meta, matrix } = await vectors.loadMatrix(PAPERS);
  if (!ids?.length || matrix.rows < 3) {
    return null;
  }
  const Mn = makeMatrix(matrix.rows, matrix.dim, new Float32Array(matrix.data));
  normalize(Mn);
  const tuning = autoTuneCommunityParams(Mn, { minSize: 2 });
  const communities = communityDetection(Mn, {
    threshold: tuning.threshold,
    minCommunitySize: 2,
  });
  // Sort once by descending size; the picker walks this list head-first.
  communities.sort((a, b) => b.length - a.length);
  const distribution = await profileFromMatrix(Mn);
  // Propagation threshold = 99th percentile of pairwise cosines on
  // THIS corpus, with a hard floor at 0.85. Without the floor, a
  // diverse corpus where p99 lands at 0.55 would propagate every
  // exclude/include to its whole topical cluster — exactly the bug
  // that produced 217 wrong includes earlier.
  const rawP99 = distribution?.cosine_percentiles?.p99 ?? (tuning.threshold + 1) / 2;
  const propagationThreshold = Math.max(0.85, rawP99);
  _corpusProfile = {
    n_papers: matrix.rows,
    computed_at: new Date().toISOString(),
    matrix: Mn,
    meta,
    ids,
    tuning,
    communities,
    distribution,
    propagation_threshold: propagationThreshold,
  };
  return _corpusProfile;
}

// Legacy alias kept for callers — same cache.
export function invalidateEmbeddingProfile() { invalidateCorpusProfile(); }

async function profileFromMatrix(M) {
  const n = M.rows;
  if (n < 3) return null;
  const targetPairs = Math.min(5000, (n * (n - 1)) / 2);
  const samples = new Float32Array(targetPairs);
  let filled = 0;
  const seen = new Set();
  while (filled < targetPairs) {
    const i = Math.floor(Math.random() * n);
    const j = Math.floor(Math.random() * n);
    if (i === j) continue;
    const key = i < j ? `${i}.${j}` : `${j}.${i}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let s = 0;
    const offI = i * M.dim;
    const offJ = j * M.dim;
    for (let d = 0; d < M.dim; d++) s += M.data[offI + d] * M.data[offJ + d];
    samples[filled++] = s;
  }
  const sorted = Array.from(samples).sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const buckets = [];
  for (let lo = -1; lo < 1; lo += 0.05) {
    const hi = Math.min(1, lo + 0.05);
    let count = 0;
    for (const v of sorted) { if (v >= lo && v < hi) count++; }
    buckets.push({ lo: Number(lo.toFixed(2)), hi: Number(hi.toFixed(2)), n: count });
  }
  return {
    n_papers: n,
    n_samples: filled,
    cosine_percentiles: {
      p25: pct(0.25), p50: pct(0.50), p75: pct(0.75),
      p90: pct(0.90), p95: pct(0.95), p99: pct(0.99),
    },
    cosine_histogram: buckets,
  };
}

// Public endpoint: run k-NN + community detection + the pairwise
// distribution probe on the current corpus and return all of it. No
// decisions made; this is purely for the user to inspect what the
// embedder sees before any threshold is "set" downstream.
export async function profileEmbeddings() {
  const { ids, matrix } = await vectors.loadMatrix(PAPERS);
  if (!ids || matrix.rows < 3) {
    return { ok: false, reason: 'too few embedded papers — at least 3 needed' };
  }
  const M = makeMatrix(matrix.rows, matrix.dim, new Float32Array(matrix.data));
  normalize(M);
  const tuning = autoTuneCommunityParams(M, { minSize: 2 });
  const distribution = await profileFromMatrix(M);
  const communities = communityDetection(M, {
    threshold: tuning.threshold,
    minCommunitySize: 2,
  });
  const communitySizes = communities.map((c) => c.length).sort((a, b) => b - a);

  return {
    ok: true,
    ...distribution,
    suggested: {
      // Data-driven propagation threshold: top 1% of pairwise cosines.
      // The picker uses this directly, NOT a magic constant.
      propagation_threshold: distribution.cosine_percentiles.p99,
      community_threshold: tuning.threshold,
      min_community_size: tuning.minCommunitySize,
      k_used: tuning.k_used,
    },
    communities: {
      count: communities.length,
      largest: communitySizes[0] || 0,
      sizes: communitySizes.slice(0, 20),
      singletons: matrix.rows - communities.reduce((s, c) => s + c.length, 0),
    },
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
  // Every paper labeled include or maybe needs to be handed to the
  // download daemon. The row-detail /api/triage/decision endpoint
  // does this, but stepTraining was bypassing it, leaving hundreds
  // of "Include" papers with no download queue entry.
  const validLabel = label === 'include' || label === 'exclude' || label === 'maybe';
  const enqueueForDownload = label === 'include' || label === 'maybe';
  let centroidSkipped = null;

  async function enqueueIfDownloadable(paperId) {
    if (!enqueueForDownload || !paperId) return;
    try {
      const allRows = await triage.getAll();
      const row = allRows.find((r) => r.paper_id === paperId);
      if (row) downloadDaemon.enqueue(row);
    } catch { /* daemon enqueue is best-effort */ }
  }

  if (Number.isInteger(row_index) && validLabel) {
    const res = await triage.setDecision({ row_index, label, reason: reason || '' });
    if (res?.skipped) {
      // The centroid row is gone from the CSV (stale vector store or
      // racing rewrite). Don't propagate the label to cluster_members
      // either, since the centroid decision wasn't actually recorded.
      // Bubble the skip up so the client can show a clear error.
      centroidSkipped = res.reason || 'row gone';
    } else {
      await enqueueIfDownloadable(res?.paper_id);
    }

    // Phase 2 — propagate the label to every other member of the cluster
    // the centroid represents. Skip propagation entirely if the centroid
    // itself wasn't recorded (stale row).
    if (!centroidSkipped && Array.isArray(cluster_members) && cluster_members.length > 1) {
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
          const propRes = await triage.setDecision({ row_index: mi, label, reason: propagatedReason });
          cluster_applied++;
          await enqueueIfDownloadable(propRes?.paper_id);
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
    centroid_skipped: centroidSkipped,
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
