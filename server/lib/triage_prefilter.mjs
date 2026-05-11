// triage_prefilter.mjs
//
// Stage 2 automation: read the papers vectors store (title+abstract
// embeddings produced by the embed daemon), compute include/exclude
// prototype centroids from the student's existing decisions, and score
// pending rows against both. Confident decisions auto-apply; the
// borderline band falls through to LLM/manual triage. "Find missed
// includes" surfaces rows the student already excluded that look like
// they should have been included.
//
// Design notes:
//   - We use margin-based decisions (include_score - exclude_score) rather
//     than absolute thresholds, because cosine scores against same-genre
//     English text never fall below ~0.4. Two prototypes and a margin
//     decouple "this paper is on-topic" from "this paper belongs to your
//     include set vs your exclude set", which is the real question.
//   - Student decisions are sacred. applyDecisions() only writes to rows
//     whose triage_label is empty. Existing include/exclude/maybe stays.
//   - "maybe" is treated as a deliberate "I'm not sure" — neither in the
//     include prototype nor the exclude one. Just left alone.
//   - Find-missed-includes is non-mutating; it returns a list of excluded
//     rows ranked by include-centroid affinity for the student to review.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DATA_DIR } from '../paths.mjs';
import { ensureDir } from '../storage.mjs';
import * as vectors from './vectors.mjs';
import * as triage from './triage.mjs';
import {
  makeMatrix, normalize, communityDetection, autoTuneCommunityParams,
} from './sbert_utils.mjs';
import { loadSyntheticPrototypes } from './synthetic_prototypes.mjs';

const PAPERS = 'papers';
const THRESHOLDS_FILE = path.join(DATA_DIR, '_triage_thresholds.json');

export const DEFAULT_THRESHOLDS = Object.freeze({
  // Minimum cosine to the include prototype required to auto-include.
  // Empirically the noise floor of bge-small on same-genre English text
  // is ~0.5; 0.65 is a comfortable "clearly aligned with prototype" floor.
  include_threshold: 0.65,
  // Same idea for exclude.
  exclude_threshold: 0.65,
  // How much closer to the winning prototype the candidate must be to
  // auto-decide. Filters out the "this paper is on-topic for both" case
  // that pure absolute thresholds would mis-handle.
  margin_threshold: 0.10,
});

// ---------------------------------------------------------------------------
// Thresholds persistence (lives under project/data/_triage_thresholds.json)
// ---------------------------------------------------------------------------

export async function readThresholds() {
  try {
    const text = await fs.readFile(THRESHOLDS_FILE, 'utf8');
    const t = JSON.parse(text);
    return { ...DEFAULT_THRESHOLDS, ...t };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULT_THRESHOLDS };
    throw err;
  }
}

export async function writeThresholds(patch) {
  const merged = { ...DEFAULT_THRESHOLDS, ...(patch || {}) };
  for (const k of ['include_threshold', 'exclude_threshold', 'margin_threshold']) {
    const v = merged[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`${k} must be a number in [0, 1]`);
    }
  }
  await ensureDir(DATA_DIR);
  await fs.writeFile(THRESHOLDS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// ---------------------------------------------------------------------------
// Prototype centroids
// ---------------------------------------------------------------------------

// Vector-store meta carries a snapshot of triage_label from when the row
// was last embedded — it goes stale the moment a paper gets labeled
// (because labeling doesn't change title+abstract, so the daemon's content
// hash matches and no re-embed fires). Always join against the CSV at
// query time; it's the source of truth.
async function loadLabelsByRowIndex() {
  const rows = await triage.getAll();
  const map = new Map();
  for (const r of rows) map.set(Number(r.row_index), r.triage_label || '');
  return map;
}

// Resolve the canonical row_index for a vectors-store record. Our embedder
// stamps both fields; older records may only carry one.
function recordRowIndex(meta, id) {
  if (meta && Number.isInteger(meta.row_index)) return meta.row_index;
  const n = Number(id);
  return Number.isInteger(n) ? n : -1;
}

// Collect the row embeddings whose CSV-resolved label matches the target,
// returning a dim-wide flat matrix + meta arrays in the same order. Used
// as the input to both communityDetection and the k-NN fallback path.
function gatherEmbeddings(ids, meta, matrix, labelByIdx, targetLabel) {
  const { data, dim } = matrix;
  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    const ridx = recordRowIndex(meta[i], ids[i]);
    const live = labelByIdx.get(ridx) || '';
    if (live !== targetLabel) continue;
    rows.push({
      meta: meta[i],
      embedding: data.subarray(i * dim, (i + 1) * dim),
    });
  }
  if (rows.length === 0) return { matrix: makeMatrix(0, dim), metas: [] };
  const flat = new Float32Array(rows.length * dim);
  for (let i = 0; i < rows.length; i++) flat.set(rows[i].embedding, i * dim);
  return { matrix: makeMatrix(rows.length, dim, flat), metas: rows.map((r) => r.meta) };
}

// Compute the unit-normalized mean of a set of labeled embeddings. Used
// as the centroid of a community (or as a per-class fallback prototype
// when the label set is too small to form any community).
function centroidOf(M, indices = null) {
  const { data, rows, dim } = M;
  const idx = indices ?? Array.from({ length: rows }, (_, i) => i);
  if (idx.length === 0) return null;
  const acc = new Float32Array(dim);
  for (const i of idx) {
    const off = i * dim;
    for (let k = 0; k < dim; k++) acc[k] += data[off + k];
  }
  for (let k = 0; k < dim; k++) acc[k] /= idx.length;
  let norm = 0;
  for (let k = 0; k < dim; k++) norm += acc[k] * acc[k];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let k = 0; k < dim; k++) acc[k] /= norm;
  return acc;
}

// Build per-class sub-prototypes. For each labeled set:
//   - if size ≥ minCommunityBoot (default 6): run communityDetection with
//     k-NN-tuned threshold and minCommunitySize → each discovered
//     community contributes its centroid as a sub-prototype, plus singleton
//     rows (not in any community) contribute themselves as 1-of-1 prototypes
//   - otherwise: fall back to per-row k-NN, where every labeled embedding
//     is itself a prototype. Honest to the data, no over-smoothing.
//
// The classifier scores a pending paper by max-cosine to any include
// sub-prototype vs max-cosine to any exclude sub-prototype, then computes
// margin between the two. This handles multi-modal classes natively.
function buildSubPrototypes(matrix, opts = {}) {
  const { minCommunityBoot = 6 } = opts;
  const dim = matrix.dim;
  if (matrix.rows === 0) return { prototypes: [], tuning: null };
  if (matrix.rows < minCommunityBoot) {
    // Use every labeled embedding as its own prototype (k-NN baseline).
    const Mn = makeMatrix(matrix.rows, dim, new Float32Array(matrix.data));
    normalize(Mn);
    const prototypes = [];
    for (let i = 0; i < matrix.rows; i++) {
      prototypes.push({
        vec: new Float32Array(Mn.data.subarray(i * dim, (i + 1) * dim)),
        size: 1,
        members: [i],
      });
    }
    return { prototypes, tuning: { mode: 'k-nn', count: matrix.rows } };
  }
  // Auto-tune communityDetection parameters from this corpus's own density.
  const tuning = autoTuneCommunityParams(matrix);
  const communities = communityDetection(matrix, {
    threshold: tuning.threshold,
    minCommunitySize: tuning.minCommunitySize,
  });
  // Track which labels ended up in any community so the leftover singletons
  // still contribute as their own prototypes.
  const inCommunity = new Set();
  const prototypes = [];
  for (const group of communities) {
    prototypes.push({
      vec: centroidOf(matrix, group),
      size: group.length,
      members: group,
      central_member: group[0], // communityDetection puts the densest first
    });
    for (const i of group) inCommunity.add(i);
  }
  // Singletons that didn't make any community → each becomes its own prototype.
  const Mn = makeMatrix(matrix.rows, dim, new Float32Array(matrix.data));
  normalize(Mn);
  for (let i = 0; i < matrix.rows; i++) {
    if (inCommunity.has(i)) continue;
    prototypes.push({
      vec: new Float32Array(Mn.data.subarray(i * dim, (i + 1) * dim)),
      size: 1,
      members: [i],
    });
  }
  return {
    prototypes,
    tuning: {
      mode: 'community',
      threshold: tuning.threshold,
      minCommunitySize: tuning.minCommunitySize,
      communities_found: communities.length,
      singletons: prototypes.length - communities.length,
      count: matrix.rows,
    },
  };
}

export async function computePrototypes() {
  const { ids, meta, matrix } = await vectors.loadMatrix(PAPERS);
  const labelByIdx = await loadLabelsByRowIndex();
  const incSet = gatherEmbeddings(ids, meta, matrix, labelByIdx, 'include');
  const excSet = gatherEmbeddings(ids, meta, matrix, labelByIdx, 'exclude');
  const inc = buildSubPrototypes(incSet.matrix);
  const exc = buildSubPrototypes(excSet.matrix);

  // Append synthetic prototypes derived from the student's topic abstract
  // and inclusion/exclusion criteria text. These solve cold-start AND
  // class-imbalance by giving each side concrete anchors regardless of
  // how many papers the student has labeled.
  const synth = await loadSyntheticPrototypes();
  const includePrototypes = inc.prototypes.concat(synth.include);
  const excludePrototypes = exc.prototypes.concat(synth.exclude);

  return {
    include_prototypes: includePrototypes,
    include_count: incSet.matrix.rows,
    include_tuning: inc.tuning,
    include_metas: incSet.metas,
    include_synthetic_count: synth.include.length,
    exclude_prototypes: excludePrototypes,
    exclude_count: excSet.matrix.rows,
    exclude_tuning: exc.tuning,
    exclude_metas: excSet.metas,
    exclude_synthetic_count: synth.exclude.length,
    dim: matrix.dim,
    _label_by_idx: labelByIdx,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function dotF32(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Max cosine from a query row to any sub-prototype in the set. Also returns
// the best-matching prototype index so the UI can show "this looked like
// your 'GDPR compliance' cluster".
function bestProtoScore(rowVec, prototypes) {
  if (!prototypes.length) return { score: null, prototype_idx: -1 };
  let best = -Infinity;
  let bestIdx = -1;
  for (let p = 0; p < prototypes.length; p++) {
    const s = dotF32(rowVec, prototypes[p].vec);
    if (s > best) { best = s; bestIdx = p; }
  }
  return { score: best, prototype_idx: bestIdx };
}

// For each pending row, score against the sub-prototype banks for both
// classes and decide.
//
// Score for class X = max cosine to any sub-prototype in X. Margin =
// includeScore − excludeScore. The max-cosine approach is what makes
// multi-modal include sets work: a paper about "GDPR + technical privacy"
// can match the technical sub-prototype even if the policy sub-prototype
// pulls the include centroid in a different direction.
export async function previewDecisions(thresholdsOverride) {
  const t = thresholdsOverride
    ? { ...DEFAULT_THRESHOLDS, ...thresholdsOverride }
    : await readThresholds();
  const proto = await computePrototypes();
  if (!proto.include_prototypes.length || !proto.exclude_prototypes.length) {
    const missing = [];
    if (!proto.include_prototypes.length) missing.push('include side (label a paper or write inclusion criteria in Setup)');
    if (!proto.exclude_prototypes.length) missing.push('exclude side (label a paper or write exclusion criteria in Setup)');
    return {
      ok: false,
      reason: 'need at least one prototype on each side — ' + missing.join('; '),
      prototype_counts: { include: proto.include_count, exclude: proto.exclude_count },
      tuning: { include: proto.include_tuning, exclude: proto.exclude_tuning },
      thresholds: t,
      proposed: [],
      borderline: [],
    };
  }
  const { ids, meta, matrix } = await vectors.loadMatrix(PAPERS);
  const labelByIdx = proto._label_by_idx; // already loaded; reuse
  const { data, dim } = matrix;
  // Normalize pending rows once (sub-prototypes are already unit-length).
  const Mn = makeMatrix(matrix.rows, dim, new Float32Array(data));
  normalize(Mn);
  const proposed = [];
  const borderline = [];
  for (let i = 0; i < ids.length; i++) {
    const ridx = recordRowIndex(meta[i], ids[i]);
    const live = labelByIdx.get(ridx) || '';
    if (live) continue; // only pending — read from CSV, not stale meta
    const row = Mn.data.subarray(i * dim, (i + 1) * dim);
    const incHit = bestProtoScore(row, proto.include_prototypes);
    const excHit = bestProtoScore(row, proto.exclude_prototypes);
    const inc = incHit.score;
    const exc = excHit.score;
    const margin = inc - exc;
    const base = {
      row_index: ridx,
      title: meta[i].title || '',
      include_score: inc,
      exclude_score: exc,
      margin,
      include_prototype_idx: incHit.prototype_idx,
      exclude_prototype_idx: excHit.prototype_idx,
    };
    if (margin > t.margin_threshold && inc > t.include_threshold) {
      proposed.push({ ...base, decision: 'include' });
    } else if (margin < -t.margin_threshold && exc > t.exclude_threshold) {
      proposed.push({ ...base, decision: 'exclude' });
    } else {
      borderline.push(base);
    }
  }
  // Most-confident decisions first; most-confident-borderline-first so the
  // student can see "this nearly passed" and lower the threshold knowingly.
  proposed.sort((a, b) => Math.abs(b.margin) - Math.abs(a.margin));
  borderline.sort((a, b) => Math.abs(b.margin) - Math.abs(a.margin));

  // Diagnostic stats so "0 confident, N borderline" stops being a black box.
  const allScored = proposed.concat(borderline);
  const stats = computeStats(allScored, t);
  return {
    ok: true,
    prototype_counts: { include: proto.include_count, exclude: proto.exclude_count },
    // Surface what the classifier actually built — number of sub-prototypes
    // per class, whether we used community mode or k-NN fallback, and the
    // auto-tuned threshold so the student knows what's happening.
    tuning: {
      include: proto.include_tuning,
      exclude: proto.exclude_tuning,
      include_sub_prototypes: proto.include_prototypes.length,
      exclude_sub_prototypes: proto.exclude_prototypes.length,
      // Split the count so the UI can show "X from your labels + Y from
      // your criteria text". Makes the synthetic anchors transparent.
      include_synthetic: proto.include_synthetic_count,
      exclude_synthetic: proto.exclude_synthetic_count,
    },
    thresholds: t,
    proposed,
    borderline,
    stats,
  };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function computeStats(scored, currentThresholds) {
  if (scored.length === 0) return null;
  const margins = scored.map((s) => s.margin).sort((a, b) => a - b);
  const incScores = scored.map((s) => s.include_score).sort((a, b) => a - b);
  const excScores = scored.map((s) => s.exclude_score).sort((a, b) => a - b);

  // Threshold sweep — show the student how many would auto-decide at
  // various loosenings of the margin requirement, keeping their absolute
  // floors. We compute both sides (would-include vs would-exclude).
  const marginValues = [0.02, 0.05, 0.08, 0.10, 0.15, 0.20];
  const floorValues = [0.50, 0.55, 0.60, 0.65, 0.70];

  const marginSweep = marginValues.map((m) => {
    let inc = 0, exc = 0;
    for (const s of scored) {
      if (s.margin > m && s.include_score > currentThresholds.include_threshold) inc++;
      else if (s.margin < -m && s.exclude_score > currentThresholds.exclude_threshold) exc++;
    }
    return { margin: m, would_include: inc, would_exclude: exc, total: inc + exc };
  });

  const floorSweep = floorValues.map((f) => {
    let inc = 0, exc = 0;
    for (const s of scored) {
      if (s.margin > currentThresholds.margin_threshold && s.include_score > f) inc++;
      else if (s.margin < -currentThresholds.margin_threshold && s.exclude_score > f) exc++;
    }
    return { floor: f, would_include: inc, would_exclude: exc, total: inc + exc };
  });

  return {
    n_scored: scored.length,
    margin: {
      min: margins[0],
      p25: quantile(margins, 0.25),
      median: quantile(margins, 0.5),
      p75: quantile(margins, 0.75),
      max: margins[margins.length - 1],
    },
    include_score: {
      min: incScores[0],
      median: quantile(incScores, 0.5),
      max: incScores[incScores.length - 1],
    },
    exclude_score: {
      min: excScores[0],
      median: quantile(excScores, 0.5),
      max: excScores[excScores.length - 1],
    },
    margin_sweep: marginSweep,
    floor_sweep: floorSweep,
  };
}

// Active-learning order for the pending queue: most-uncertain papers first
// (smallest |margin|). Items scored without prototypes (cold start) sort
// to the end. Uses max-over-sub-prototypes, same as previewDecisions.
export async function rankPendingByUncertainty() {
  const proto = await computePrototypes();
  const labelByIdx = proto._label_by_idx;
  const { ids, meta, matrix } = await vectors.loadMatrix(PAPERS);
  const dim = matrix.dim;
  const haveBoth = !!(proto.include_prototypes.length && proto.exclude_prototypes.length);
  const Mn = haveBoth
    ? (() => { const M = makeMatrix(matrix.rows, dim, new Float32Array(matrix.data)); normalize(M); return M; })()
    : null;
  const ranked = [];
  for (let i = 0; i < ids.length; i++) {
    const ridx = recordRowIndex(meta[i], ids[i]);
    if (labelByIdx.get(ridx)) continue;
    let uncertainty = -1;
    let include_score = null;
    let exclude_score = null;
    if (haveBoth) {
      const row = Mn.data.subarray(i * dim, (i + 1) * dim);
      include_score = bestProtoScore(row, proto.include_prototypes).score;
      exclude_score = bestProtoScore(row, proto.exclude_prototypes).score;
      uncertainty = 1 - Math.abs(include_score - exclude_score);
    }
    ranked.push({
      row_index: ridx,
      title: meta[i].title || '',
      uncertainty,
      include_score,
      exclude_score,
    });
  }
  ranked.sort((a, b) => b.uncertainty - a.uncertainty);
  return {
    ok: true,
    prototype_counts: { include: proto.include_count, exclude: proto.exclude_count },
    ranked,
  };
}

// Scan rows labeled 'exclude' for high include-prototype affinity (any
// sub-prototype). Non-mutating; returns top-K most-suspicious by score.
export async function findMissedIncludes({ topK = 20, minScore = 0.6 } = {}) {
  const proto = await computePrototypes();
  if (!proto.include_prototypes.length) {
    return { ok: false, reason: 'no include decisions yet', missed: [] };
  }
  const labelByIdx = proto._label_by_idx;
  const { ids, meta, matrix } = await vectors.loadMatrix(PAPERS);
  const dim = matrix.dim;
  const Mn = makeMatrix(matrix.rows, dim, new Float32Array(matrix.data));
  normalize(Mn);
  const scored = [];
  for (let i = 0; i < ids.length; i++) {
    const ridx = recordRowIndex(meta[i], ids[i]);
    if (labelByIdx.get(ridx) !== 'exclude') continue;
    const row = Mn.data.subarray(i * dim, (i + 1) * dim);
    const include_score = bestProtoScore(row, proto.include_prototypes).score;
    if (include_score < minScore) continue;
    scored.push({
      row_index: ridx,
      title: meta[i].title || '',
      include_score,
    });
  }
  scored.sort((a, b) => b.include_score - a.include_score);
  return {
    ok: true,
    missed: scored.slice(0, topK),
  };
}

// Discover & report the sub-prototype structure of the current labeled
// sets without scoring anything. Used by the UI to render "your includes
// form N sub-themes" so the student can sanity-check what the classifier
// is actually modelling.
export async function describeCommunities() {
  const proto = await computePrototypes();
  const summarise = (prototypes, metas) => prototypes.map((p, idx) => ({
    idx,
    size: p.size,
    member_titles: p.members
      .map((mi) => metas[mi]?.title || '')
      .filter(Boolean)
      .slice(0, 5),
    central_title: p.central_member != null ? (metas[p.central_member]?.title || '') : null,
  }));
  return {
    ok: true,
    include: {
      count: proto.include_count,
      tuning: proto.include_tuning,
      sub_prototypes: summarise(proto.include_prototypes, proto.include_metas),
    },
    exclude: {
      count: proto.exclude_count,
      tuning: proto.exclude_tuning,
      sub_prototypes: summarise(proto.exclude_prototypes, proto.exclude_metas),
    },
  };
}

// ---------------------------------------------------------------------------
// Apply decisions to the triage CSV
// ---------------------------------------------------------------------------

// Bulk-apply pre-filter decisions. Only writes to rows where the student
// hasn't already decided. Each accepted decision goes through
// triage.setDecision so all downstream side effects (paper_id assignment,
// download daemon enqueue, embed daemon resync) fire normally.
export async function applyDecisions(decisions, opts = {}) {
  const { reasonPrefix = 'auto-triage (embedding pre-filter)' } = opts;
  const papers = await triage.getAll();
  const byIndex = new Map(papers.map((p) => [p.row_index, p]));
  let applied = 0;
  let skipped = 0;
  const errors = [];
  for (const d of decisions) {
    const idx = Number(d.row_index);
    const row = byIndex.get(idx);
    if (!row) {
      errors.push({ row_index: idx, error: 'row not found in triage' });
      continue;
    }
    if (row.triage_label && row.triage_label !== '') {
      skipped++;
      continue;
    }
    if (d.decision !== 'include' && d.decision !== 'exclude' && d.decision !== 'maybe') {
      errors.push({ row_index: idx, error: `unsupported decision: ${d.decision}` });
      continue;
    }
    const reason = `${reasonPrefix} — inc ${(d.include_score ?? 0).toFixed(3)} / exc ${(d.exclude_score ?? 0).toFixed(3)} / margin ${(d.margin ?? 0).toFixed(3)}`;
    try {
      await triage.setDecision({ row_index: idx, label: d.decision, reason });
      applied++;
    } catch (err) {
      errors.push({ row_index: idx, error: err.message });
    }
  }
  return { applied, skipped, errors };
}

// Convenience: preview with current thresholds, then apply everything
// proposed. Returns combined result.
export async function runAutoTriage() {
  const preview = await previewDecisions();
  if (!preview.ok) return { ...preview, applied: 0 };
  const result = await applyDecisions(preview.proposed);
  return { ...preview, ...result };
}

// Aggressive finish: decide ALL pending papers by closer-side-wins,
// regardless of margin or absolute floor. Used after substantial training
// (typically 50+ decisions) when the student trusts the prototypes enough
// to commit on the borderline residue. Papers where include and exclude
// prototypes are exactly tied (very rare) fall back to 'maybe'.
//
// Returns { ok, attempted, applied, applied_include, applied_exclude,
//          applied_maybe, ties }.
export async function finishRemaining() {
  const proto = await computePrototypes();
  if (!proto.include_prototypes.length || !proto.exclude_prototypes.length) {
    return {
      ok: false,
      reason: 'need at least one include AND one exclude prototype before finishing',
      attempted: 0, applied: 0,
    };
  }
  const labelByIdx = proto._label_by_idx;
  const { ids, meta, matrix } = await vectors.loadMatrix(PAPERS);
  const dim = matrix.dim;
  const Mn = makeMatrix(matrix.rows, dim, new Float32Array(matrix.data));
  normalize(Mn);

  const decisions = [];
  let ties = 0;
  for (let i = 0; i < ids.length; i++) {
    const ridx = recordRowIndex(meta[i], ids[i]);
    if (labelByIdx.get(ridx)) continue; // skip already-labeled
    const row = Mn.data.subarray(i * dim, (i + 1) * dim);
    const incHit = bestProtoScore(row, proto.include_prototypes);
    const excHit = bestProtoScore(row, proto.exclude_prototypes);
    const inc = incHit.score;
    const exc = excHit.score;
    let decision;
    if (inc > exc) decision = 'include';
    else if (exc > inc) decision = 'exclude';
    else { decision = 'maybe'; ties++; }
    decisions.push({
      row_index: ridx,
      decision,
      include_score: inc,
      exclude_score: exc,
      margin: inc - exc,
    });
  }
  if (decisions.length === 0) {
    return { ok: true, attempted: 0, applied: 0, applied_include: 0, applied_exclude: 0, applied_maybe: 0, ties: 0 };
  }
  const result = await applyDecisions(decisions, {
    reasonPrefix: 'auto-triage (closer-side-wins after training)',
  });
  const counts = decisions.reduce((acc, d) => {
    if (d.decision === 'include') acc.include++;
    else if (d.decision === 'exclude') acc.exclude++;
    else acc.maybe++;
    return acc;
  }, { include: 0, exclude: 0, maybe: 0 });
  return {
    ok: true,
    attempted: decisions.length,
    applied: result.applied,
    applied_include: counts.include,
    applied_exclude: counts.exclude,
    applied_maybe: counts.maybe,
    ties,
    errors: result.errors,
  };
}
