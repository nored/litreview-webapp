// remediation.mjs
//
// Phase 7 — closed-loop remediation. Walks the pipeline state and turns
// signals into concrete action cards: "Triage N pending hits", "Polish
// N invalid notes", "Address N must-cite paper(s) missing from the
// catalogue", etc. Each card has a severity, a count, a one-line
// explanation, and a deep-link to the stage that resolves it.
//
// The module is pure aggregation — no new analyses, no LLM calls. It
// reads what's already on disk + what existing modules expose, and
// composes a unified to-do list. The student then clicks through to the
// relevant stage to act on it.
//
// Categories surfaced:
//   - triage    : pending CSV rows; maybe-bucket items that need resolution
//   - download  : includes/maybes whose PDF didn't land yet
//   - notes     : eligible papers with no draft, or notes flagged invalid
//   - synthesis : gap candidates without an overall verdict; clustered
//                 limitations that warrant a candidate
//   - catalogue : must-cite papers not cited in the saved catalogue.md
//                 (and other coverage misses)
//
// Severity model:
//   red    — blocks the next pipeline stage or violates a must-cite invariant
//   yellow — quality concern; pipeline still works without resolving
//   green  — informational / opportunity (not currently emitted but
//            reserved so the UI can render encouraging states)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NOTES_DIR, SYNTHESIS_DIR } from '../paths.mjs';
import { readText, fileExists } from '../storage.mjs';
import * as triage from './triage.mjs';
import * as notes from './notes.mjs';
import * as synthesis from './synthesis.mjs';
import * as aggregator from './notes_aggregator.mjs';
import * as gapDetection from './gap_detection.mjs';
import * as catalogueGrounded from './catalogue_grounded.mjs';
import * as snowballDaemon from './snowball_daemon.mjs';

const CATALOGUE_PATH = path.join(SYNTHESIS_DIR, 'catalogue.md');

// Threshold for promoting a limitations cluster to a "this should be a
// candidate" recommendation. Clusters at or above this size of distinct
// papers are worth surfacing as a synthesis opportunity.
const LIMITATIONS_CLUSTER_MIN_PAPERS = 3;

function card({ id, severity, category, title, detail, count, examples, action }) {
  return {
    id,
    severity,
    category,
    title,
    detail,
    count: typeof count === 'number' ? count : null,
    examples: examples || [],
    action: action || null,
  };
}

// ---------------------------------------------------------------------------
// Triage signals
// ---------------------------------------------------------------------------

async function triageSignals() {
  let summary;
  try {
    summary = await triage.summary();
  } catch {
    return [];
  }
  const out = [];
  const pending = summary.pending || 0;
  const maybe = summary.maybe || 0;
  if (pending > 0) {
    out.push(card({
      id: 'triage.pending',
      severity: pending >= 20 ? 'red' : 'yellow',
      category: 'triage',
      title: `Triage ${pending} pending hit${pending === 1 ? '' : 's'}`,
      detail: 'These rows in candidates_triaged.csv have no include/exclude/maybe label yet. Run the triage wizard to clear them.',
      count: pending,
      action: { label: 'Open stage 2 — Triage', href: '#/stage2' },
    }));
  }
  if (maybe > 0) {
    out.push(card({
      id: 'triage.maybe',
      severity: 'yellow',
      category: 'triage',
      title: `Resolve ${maybe} maybe-bucket item${maybe === 1 ? '' : 's'}`,
      detail: 'Maybe-labeled papers got included for download but the verdict is still open. Either confirm include or change to exclude before deep-read.',
      count: maybe,
      action: { label: 'Open stage 2 — Triage', href: '#/stage2' },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Download / PDF signals — papers labeled include or maybe whose PDF
// hasn't landed yet. listEligible already filters to PDF-present rows so
// we have to ask triage directly.
// ---------------------------------------------------------------------------

async function downloadSignals() {
  let rows;
  try {
    rows = await triage.getAll();
  } catch {
    return [];
  }
  const eligible = await notes.listEligible();
  const eligibleIds = new Set(eligible.map((p) => p.paper_id));
  const labeled = rows.filter((r) => r.triage_label === 'include' || r.triage_label === 'maybe');
  const missing = labeled.filter((r) => r.paper_id && !eligibleIds.has(r.paper_id));
  if (missing.length === 0) return [];
  return [card({
    id: 'download.missing_pdfs',
    severity: 'yellow',
    category: 'download',
    title: `${missing.length} include/maybe paper${missing.length === 1 ? ' has' : 's have'} no PDF yet`,
    detail: 'These rows are labeled include or maybe but a PDF never landed in data/pdfs/. Resume the download daemon or use the manual retrieval list.',
    count: missing.length,
    examples: missing.slice(0, 5).map((r) => `paper_${r.paper_id} — ${(r.title || '').slice(0, 90)}`),
    action: { label: 'Open stage 3 — Download', href: '#/stage3' },
  })];
}

// ---------------------------------------------------------------------------
// Notes signals
// ---------------------------------------------------------------------------

async function notesSignals() {
  let eligible;
  try {
    eligible = await notes.listEligible();
  } catch {
    return [];
  }
  const out = [];
  const missing = eligible.filter((p) => p.note_status === 'none');
  const draft = eligible.filter((p) => p.note_status === 'draft');
  if (missing.length > 0) {
    out.push(card({
      id: 'notes.missing',
      severity: 'red',
      category: 'notes',
      title: `Draft ${missing.length} missing note${missing.length === 1 ? '' : 's'}`,
      detail: 'Eligible papers with a PDF but no note yet. Stage 4\'s batch button will draft all of them; toggle "Audit & revise" if you want the critic pass.',
      count: missing.length,
      examples: missing.slice(0, 5).map((p) => `paper_${p.paper_id} — ${(p.title || '').slice(0, 90)}`),
      action: { label: 'Open stage 4 — Deep read', href: '#/stage4' },
    }));
  }
  if (draft.length > 0) {
    out.push(card({
      id: 'notes.draft',
      severity: 'yellow',
      category: 'notes',
      title: `Polish ${draft.length} invalid note${draft.length === 1 ? '' : 's'}`,
      detail: 'Notes exist but fail validation (missing fields, schema problems). Open each one to see the issue panel and fix it.',
      count: draft.length,
      examples: draft.slice(0, 5).map((p) => `paper_${p.paper_id} — ${(p.title || '').slice(0, 90)}`),
      action: { label: 'Open stage 4 — Deep read', href: '#/stage4' },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Synthesis signals — gap candidates without verdicts; large limitations
// clusters that should be promoted into candidates
// ---------------------------------------------------------------------------

async function synthesisSignals() {
  const out = [];
  let synthState;
  try {
    synthState = await synthesis.readState();
  } catch {
    synthState = { candidates: [] };
  }
  const candidates = synthState.candidates || [];
  const unscored = candidates.filter((c) => !c.overall);
  if (unscored.length > 0) {
    out.push(card({
      id: 'synthesis.unscored_candidates',
      severity: 'yellow',
      category: 'synthesis',
      title: `Score ${unscored.length} unscored candidate${unscored.length === 1 ? '' : 's'}`,
      detail: 'Gap candidates without an accept/refine/reject verdict are skipped by the catalogue. Run the indicator scoring in stage 5.',
      count: unscored.length,
      examples: unscored.slice(0, 5).map((c) => c.title || '(untitled candidate)'),
      action: { label: 'Open stage 5 — Synthesis', href: '#/stage5' },
    }));
  }

  // Surface large limitations clusters as potential gap candidates. This
  // is the "themes that recur across multiple papers" signal — the
  // student should consider whether each cluster deserves to become an
  // explicit candidate.
  try {
    const lim = await gapDetection.aggregateLimitations({ scope: 'include' });
    const knownTitles = new Set(candidates.map((c) => (c.title || '').toLowerCase().trim()));
    const newClusters = (lim.clusters || []).filter((c) =>
      c.paper_count >= LIMITATIONS_CLUSTER_MIN_PAPERS &&
      !knownTitles.has((c.central_text || '').toLowerCase().trim()),
    );
    if (newClusters.length > 0) {
      out.push(card({
        id: 'synthesis.limitations_clusters',
        severity: 'yellow',
        category: 'synthesis',
        title: `${newClusters.length} limitation theme${newClusters.length === 1 ? '' : 's'} not yet a candidate`,
        detail: `Clusters of stated limitations across ≥${LIMITATIONS_CLUSTER_MIN_PAPERS} papers. Each cluster is a potential gap candidate that you haven't formalised yet.`,
        count: newClusters.length,
        examples: newClusters.slice(0, 5).map((c) =>
          `${c.paper_count} papers — "${(c.central_text || '').slice(0, 100)}"`,
        ),
        action: { label: 'Open stage 5 — Synthesis', href: '#/stage5' },
      }));
    }
  } catch {
    // Aggregation can fail when no embeddings are available yet — silent.
  }

  return out;
}

// ---------------------------------------------------------------------------
// Catalogue signals — must-cite misses + other coverage gaps
// ---------------------------------------------------------------------------

async function catalogueSignals() {
  if (!await fileExists(CATALOGUE_PATH)) return [];
  const md = await readText(CATALOGUE_PATH, '');
  if (!md.trim()) return [];

  let agg;
  try {
    agg = await aggregator.aggregate();
  } catch {
    return [];
  }
  const papers = Object.values(agg.by_paper).map((p) => ({
    id: p.paper_id,
    title: p.title,
    novelty: p.novelty_strength,
    must_cite: p.must_cite,
  }));

  let coverage;
  try {
    coverage = await catalogueGrounded.coverageCheck(md, papers);
  } catch {
    return [];
  }

  const out = [];
  const mustCiteMissing = coverage.missing.filter((m) => m.must_cite);
  if (mustCiteMissing.length > 0) {
    out.push(card({
      id: 'catalogue.must_cite_missing',
      severity: 'red',
      category: 'catalogue',
      title: `Address ${mustCiteMissing.length} must-cite paper${mustCiteMissing.length === 1 ? '' : 's'} missing from the catalogue`,
      detail: 'Papers tagged must_cite in their notes did not appear with a [paper_NNN] citation in the saved catalogue. Re-generate the catalogue (or edit it manually) to integrate them.',
      count: mustCiteMissing.length,
      examples: mustCiteMissing.slice(0, 5).map((m) =>
        `paper_${m.paper_id} — ${(m.title || '').slice(0, 90)}`,
      ),
      action: { label: 'Open stage 6 — Catalogue', href: '#/stage7' },
    }));
  }

  const otherMissing = coverage.missing.filter((m) => !m.must_cite);
  // Only surface this if a meaningful fraction is missing — small
  // omissions of peripheral papers are expected in a generated catalogue.
  if (otherMissing.length >= 5 || (coverage.stats.total_includes > 0 && otherMissing.length / coverage.stats.total_includes >= 0.3)) {
    out.push(card({
      id: 'catalogue.other_missing',
      severity: 'yellow',
      category: 'catalogue',
      title: `${otherMissing.length} other paper${otherMissing.length === 1 ? '' : 's'} absent from the catalogue`,
      detail: `${coverage.stats.cited_count} of ${coverage.stats.total_includes} include papers are cited. Decide whether the omissions are intentional (peripheral / out of scope) or whether the catalogue should integrate them.`,
      count: otherMissing.length,
      examples: otherMissing.slice(0, 5).map((m) =>
        `paper_${m.paper_id} — ${(m.title || '').slice(0, 90)}`,
      ),
      action: { label: 'Open stage 6 — Catalogue', href: '#/stage7' },
    }));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Snowball signals — surface "never run" or "errored" jobs. The
// post-snowball pending-triage rows show up automatically via the
// triage.pending signal, so we don't double-report them.
// ---------------------------------------------------------------------------

const SNOWBALL_MIN_INCLUDES = 3;

async function snowballSignals() {
  const out = [];
  let s;
  try {
    s = snowballDaemon.status();
  } catch {
    return [];
  }
  const job = s?.job;
  // Count include-labelled papers to decide whether snowball is worth
  // suggesting at all.
  let includeCount = 0;
  try {
    const rows = await triage.getAll();
    includeCount = rows.filter((r) => r.triage_label === 'include').length;
  } catch { /* ignore */ }

  if (!job && includeCount >= SNOWBALL_MIN_INCLUDES) {
    out.push(card({
      id: 'snowball.not_run',
      severity: 'yellow',
      category: 'corpus',
      title: `Run snowball expansion (${includeCount} include paper${includeCount === 1 ? '' : 's'} in corpus)`,
      detail: 'Snowballing pulls forward+backward citations from your include set via OpenAlex and lands them as pending triage rows. Catches papers your keyword search missed.',
      count: includeCount,
      action: { label: 'Open stage 2 — Triage', href: '#/stage2' },
    }));
  }
  if (job?.last_error) {
    out.push(card({
      id: 'snowball.errored',
      severity: 'red',
      category: 'corpus',
      title: 'Snowball job ended with an error',
      detail: `Last job (${job.id}) reported: ${String(job.last_error).slice(0, 200)}. Inspect the daemon stream on stage 2 or restart the run.`,
      action: { label: 'Open stage 2 — Triage', href: '#/stage2' },
    }));
  }
  if (job && job.status === 'finished' && job.new_added > 0) {
    out.push(card({
      id: 'snowball.completed',
      severity: 'green',
      category: 'corpus',
      title: `Snowball added ${job.new_added} candidate${job.new_added === 1 ? '' : 's'} to triage`,
      detail: 'Completed run brought in new papers. Triage them (or confirm they got triaged) so they flow into deep-read.',
      count: job.new_added,
      action: { label: 'Open stage 2 — Triage', href: '#/stage2' },
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contradictions — paraphrase-mined pairs from the notes vector store
// that read like they may disagree. Cheap to surface; the user decides
// whether each pair is a real contradiction via the per-pair LLM judge
// in stage 5.
// ---------------------------------------------------------------------------

const CONTRADICTION_MIN_SIM = 0.78;
const CONTRADICTION_MAX_PAIRS = 20;

async function contradictionSignals() {
  let result;
  try {
    result = await gapDetection.surfaceContradictionCandidates({
      minSimilarity: CONTRADICTION_MIN_SIM,
      maxPairs: CONTRADICTION_MAX_PAIRS,
    });
  } catch {
    return [];
  }
  const pairs = result?.pairs || [];
  if (pairs.length === 0) return [];
  return [card({
    id: 'synthesis.contradictions',
    severity: 'yellow',
    category: 'synthesis',
    title: `Audit ${pairs.length} contradiction candidate pair${pairs.length === 1 ? '' : 's'}`,
    detail: `Paraphrase-mined note pairs that look similar enough that disagreement would matter (≥${CONTRADICTION_MIN_SIM} cosine). Decide per pair whether they actually contradict — stage 5's contradiction panel has the LLM judge.`,
    count: pairs.length,
    examples: pairs.slice(0, 5).map((p) =>
      `paper_${p.a?.paper_id || '?'} ↔ paper_${p.b?.paper_id || '?'}` +
      (typeof p.similarity === 'number' ? ` (sim=${p.similarity.toFixed(2)})` : ''),
    ),
    action: { label: 'Open stage 5 — Synthesis', href: '#/stage5' },
  })];
}

// ---------------------------------------------------------------------------
// Density-void cells + outliers
// ---------------------------------------------------------------------------

// "Empty intersection" detection over the agg.matrix. A void is a
// (category, method_family) cell with zero papers, where both the
// category and the method are populated elsewhere — i.e. it's a genuine
// gap inside explored territory, not just an unused dimension.
function emptyMatrixCells(agg) {
  const matrix = agg.matrix || {};
  const cats = new Set();
  const methods = new Set();
  for (const key of Object.keys(matrix)) {
    if (!matrix[key] || matrix[key].length === 0) continue;
    const [c, m] = key.split('|');
    if (c) cats.add(c);
    if (m) methods.add(m);
  }
  const voids = [];
  for (const c of cats) {
    for (const m of methods) {
      const key = `${c}|${m}`;
      if (!matrix[key] || matrix[key].length === 0) {
        voids.push({ category: c, method: m });
      }
    }
  }
  return voids;
}

const DENSITY_VOID_MIN = 2;     // surface only when ≥2 empty cells exist
const OUTLIER_MIN_DISTANCE = 0.25;
const OUTLIER_TOPK = 5;

async function corpusGapSignals() {
  const out = [];
  let agg;
  try {
    agg = await aggregator.aggregate();
  } catch {
    return [];
  }

  // Empty matrix cells inside explored rows + columns. These read as
  // "you have papers using method X and papers studying category Y, but
  // nothing at the X × Y intersection" — a defensible-but-unexplored
  // combination worth at least one candidate.
  const voids = emptyMatrixCells(agg);
  if (voids.length >= DENSITY_VOID_MIN) {
    out.push(card({
      id: 'corpus.density_voids',
      severity: 'yellow',
      category: 'corpus',
      title: `${voids.length} empty matrix cell${voids.length === 1 ? '' : 's'} in explored regions`,
      detail: 'Method × category intersections where neither dimension is empty, yet the cell holds zero papers. Each is a candidate gap worth formalising in stage 5 (or dismissing as not scope-relevant).',
      count: voids.length,
      examples: voids.slice(0, 5).map((v) => `${v.category} × ${v.method}`),
      action: { label: 'Open stage 5 — Synthesis', href: '#/stage5' },
    }));
  }

  // Centroid outliers — include notes that sit far from the corpus centroid.
  try {
    const out2 = await gapDetection.findOutliers({
      topK: OUTLIER_TOPK,
      minDistance: OUTLIER_MIN_DISTANCE,
    });
    if (out2?.items?.length > 0) {
      out.push(card({
        id: 'corpus.outliers',
        severity: 'yellow',
        category: 'corpus',
        title: `${out2.items.length} outlier note${out2.items.length === 1 ? '' : 's'} far from corpus centroid`,
        detail: 'Notes whose embedding sits ≥0.25 cosine-distance from the include corpus mean. Either tangential drift to exclude, or unique angles worth formalising as gap candidates.',
        count: out2.items.length,
        examples: out2.items.slice(0, 5).map((it) =>
          `paper_${it.paper_id} — ${(it.title || '').slice(0, 90)} (d=${it.distance.toFixed(2)})`,
        ),
        action: { label: 'Open stage 5 — Synthesis', href: '#/stage5' },
      }));
    }
  } catch { /* ignore */ }

  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { red: 0, yellow: 1, green: 2 };

export async function collectSignals() {
  const [tr, dl, nt, sy, ct, sn, co, cg] = await Promise.all([
    triageSignals(),
    downloadSignals(),
    notesSignals(),
    synthesisSignals(),
    catalogueSignals(),
    snowballSignals(),
    contradictionSignals(),
    corpusGapSignals(),
  ]);
  const all = [...tr, ...dl, ...nt, ...sy, ...ct, ...sn, ...co, ...cg];
  all.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // Summary numbers for the scorecard at the top of the view.
  const counts = {
    red: all.filter((c) => c.severity === 'red').length,
    yellow: all.filter((c) => c.severity === 'yellow').length,
    green: all.filter((c) => c.severity === 'green').length,
    total: all.length,
  };
  return { signals: all, counts };
}
