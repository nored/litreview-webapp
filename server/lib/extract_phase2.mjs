// extract_phase2.mjs
//
// Phase 2 orchestrator. Runs the four per-paper extractors on top of
// the grobid-parsed structure:
//
//   1. entities   — GLiNER on every paragraph
//   2. claims     — LLM-as-finder for typed claims (per-stage AI)
//   3. numerical  — grobid tables + LLM-as-finder on body paragraphs
//   4. stance     — LLM-stance on every citation context
//
// Steps 2-4 honour the per-stage AI provider switch; 'off' skips them
// cleanly (entities still run because GLiNER is local).
//
// Phase 1 (grobid ingest) is a hard prerequisite — without paragraphs,
// references, and citation markers in the v4 tables, none of these
// extractors have anything to work with.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFS_DIR } from '../paths.mjs';
import * as store from './store.mjs';
import { extractEntitiesForPaper } from './extract_entities_v2.mjs';
import { extractClaimsForPaper }   from './extract_claims_v2.mjs';
import { extractNumericalForPaper } from './extract_numerical_v2.mjs';
import { classifyCitationStance }  from './extract_stance_v2.mjs';
import { ingestPaperGrobid }       from './ingest_grobid.mjs';
import { generatePhase3Embeddings } from './embed_phase3.mjs';
import { runPhase3Clustering }     from './cluster_phase3.mjs';
import { detectAllPhase4 }         from './detect_phase4.mjs';

/**
 * Run all four Phase 2 extractors for one paper. opts is forwarded to
 * each (notably `provider`).
 *
 * opts.onStep(stepName, paperId) — optional callback fired before each
 * sub-step starts. Used by the corpus orchestrator so the UI can show
 * which sub-step is currently running.
 */
export async function extractPhase2ForPaper(paperId, opts = {}) {
  await store.init();
  const startMs = Date.now();
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : null;

  // Phase 1 precondition: paragraphs + citation markers from grobid.
  const paraCount = store.query('SELECT COUNT(*) AS n FROM paragraphs WHERE paper_id = ?', [paperId])[0]?.n || 0;
  if (paraCount === 0) {
    return {
      paper_id: paperId,
      error: 'phase1_required',
      hint: 'run POST /api/v2/papers/:id/grobid-ingest first',
    };
  }

  const report = {
    paper_id: paperId,
    started_at: new Date().toISOString(),
    steps: {},
    errors: [],
  };

  // 1. Entities (GLiNER, local). Always runs.
  try {
    if (onStep) await onStep('entities', paperId);
    report.steps.entities = await extractEntitiesForPaper(paperId, opts);
  } catch (e) {
    report.errors.push(`entities: ${e?.message || e}`);
  }

  // 2. Claims (LLM-as-finder, per-stage AI).
  try {
    if (onStep) await onStep('claims', paperId);
    report.steps.claims = await extractClaimsForPaper(paperId, opts);
  } catch (e) {
    report.errors.push(`claims: ${e?.message || e}`);
  }

  // 3. Numerical (tables + LLM body fallback).
  try {
    if (onStep) await onStep('numerical', paperId);
    report.steps.numerical = await extractNumericalForPaper(paperId, opts);
  } catch (e) {
    report.errors.push(`numerical: ${e?.message || e}`);
  }

  // 4. Stance (LLM on citation contexts).
  try {
    if (onStep) await onStep('stance', paperId);
    report.steps.stance = await classifyCitationStance({ ...opts, paperId });
  } catch (e) {
    report.errors.push(`stance: ${e?.message || e}`);
  }

  await store.flush();
  report.elapsed_ms = Date.now() - startMs;
  report.finished_at = new Date().toISOString();
  return report;
}

/**
 * Run the FULL v2 pipeline corpus-wide. One button, end-to-end:
 *
 *   For each paper that has a PDF on disk:
 *     1. grobid ingest         (Phase 1: sections / paragraphs / citation markers)
 *     2. entities              (Phase 2 sub-step: GLiNER over every paragraph)
 *     3. claims                (Phase 2 sub-step: LLM-as-finder, 11 claim types)
 *     4. numerical             (Phase 2 sub-step: tables + LLM body)
 *     5. stance                (Phase 2 sub-step: LLM citation classification)
 *
 *   After every paper finishes:
 *     6. phase3-embed          (one corpus-wide pass)
 *     7. phase3-cluster        (one corpus-wide pass)
 *     8. phase4-detect         (one corpus-wide pass; writes _phase4_last.json)
 *
 * Honours opts.signal (AbortSignal). Cancellation takes effect at the
 * next paper boundary or before the corpus-wide steps.
 *
 * Callbacks (all optional):
 *   - onStart({ total, ids })
 *   - onStep(stepName, paperIdOrNull)        ← fires before each sub-step
 *   - onProgress(perPaperReport, done, total)
 */
export async function extractFullPipelineCorpus(opts = {}) {
  await store.init();

  // Pick the set of papers to process.
  let rows;
  if (Array.isArray(opts.ids) && opts.ids.length) {
    const placeholders = opts.ids.map(() => '?').join(',');
    rows = store.query(
      `SELECT paper_id FROM papers WHERE paper_id IN (${placeholders}) ORDER BY paper_id`,
      opts.ids,
    );
  } else {
    rows = store.query(
      `SELECT paper_id FROM papers WHERE triage_label IN ('include', 'maybe') ORDER BY paper_id`,
    );
  }

  // Drop papers without a PDF on disk — they have nothing to extract.
  try {
    const onDisk = new Set();
    const files = await fs.readdir(PDFS_DIR);
    for (const f of files) {
      const m = /^paper_(.+)\.pdf$/.exec(f);
      if (m) onDisk.add(m[1]);
    }
    rows = rows.filter((r) => onDisk.has(String(r.paper_id)));
  } catch (e) {
    console.warn('[extractFullPipelineCorpus] cannot read PDFs dir:', e?.message || e);
  }

  const report = {
    started_at: new Date().toISOString(),
    total: rows.length,
    completed: [],
    failed: [],
  };
  if (typeof opts.onStart === 'function') {
    try { await opts.onStart({ total: rows.length, ids: rows.map((r) => r.paper_id) }); } catch {}
  }
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  // Per-paper: grobid + Phase 2.
  for (let i = 0; i < rows.length; i += 1) {
    if (opts.signal?.aborted) {
      report.aborted = true;
      report.aborted_after = i;
      break;
    }
    const paperId = rows[i].paper_id;
    const t0 = Date.now();
    const perPaper = { paper_id: paperId, started_at: new Date().toISOString(), steps: {}, errors: [] };
    try {
      if (onStep) await onStep('grobid', paperId);
      perPaper.steps.grobid = await ingestPaperGrobid(paperId);
    } catch (e) {
      perPaper.errors.push(`grobid: ${e?.message || e}`);
    }
    try {
      const p2 = await extractPhase2ForPaper(paperId, { ...opts, onStep });
      perPaper.steps.phase2 = {
        entities: p2.steps?.entities?.n_spans,
        claims:   p2.steps?.claims?.total_accepted,
        numerical: p2.steps?.numerical?.total_accepted,
        stance:   p2.steps?.stance?.classified,
      };
      perPaper.errors.push(...(p2.errors || []));
    } catch (e) {
      perPaper.errors.push(`phase2: ${e?.message || e}`);
    }
    perPaper.elapsed_ms = Date.now() - t0;
    perPaper.finished_at = new Date().toISOString();
    if (perPaper.errors.length === 0) report.completed.push(perPaper);
    else report.failed.push(perPaper);
    if (onProgress) await onProgress(perPaper, i + 1, rows.length);
  }

  // Corpus-wide tail: Phase 3 (embed + cluster) and Phase 4 (detect).
  // Each is one cheap pass over the SQLite store.
  if (!opts.signal?.aborted) {
    try {
      if (onStep) await onStep('phase3-embed', null);
      report.phase3_embed = await generatePhase3Embeddings({});
    } catch (e) {
      report.phase3_embed_error = e?.message || String(e);
    }
  }
  if (!opts.signal?.aborted) {
    try {
      if (onStep) await onStep('phase3-cluster', null);
      report.phase3_cluster = await runPhase3Clustering({});
    } catch (e) {
      report.phase3_cluster_error = e?.message || String(e);
    }
  }
  if (!opts.signal?.aborted) {
    try {
      if (onStep) await onStep('phase4-detect', null);
      const phase4 = await detectAllPhase4({});
      report.phase4 = phase4;
      // Persist for the comparator harness.
      try {
        const outPath = path.resolve(PDFS_DIR, '..', '_phase4_last.json');
        await fs.writeFile(outPath, JSON.stringify(phase4, null, 2));
      } catch {}
    } catch (e) {
      report.phase4_error = e?.message || String(e);
    }
  }
  report.finished_at = new Date().toISOString();
  return report;
}

/**
 * Run Phase 2 across every paper that has paragraphs (i.e. has been
 * grobid-ingested). Skips papers without grobid data.
 */
export async function extractPhase2Corpus(opts = {}) {
  await store.init();
  const rows = store.query(`
    SELECT DISTINCT p.paper_id FROM papers p
      INNER JOIN paragraphs pg ON pg.paper_id = p.paper_id
     WHERE p.triage_label IN ('include', 'maybe')
     ORDER BY p.paper_id
  `);
  const completed = [];
  const failed = [];
  for (let i = 0; i < rows.length; i++) {
    if (opts.signal?.aborted) break;
    const paperId = rows[i].paper_id;
    try {
      const r = await extractPhase2ForPaper(paperId, opts);
      if (r.error) failed.push(r);
      else completed.push(r);
      if (typeof opts.onProgress === 'function') {
        await opts.onProgress(r, i + 1, rows.length);
      }
    } catch (e) {
      failed.push({ paper_id: paperId, error: e?.message || String(e) });
    }
  }
  return { total: rows.length, completed, failed };
}
