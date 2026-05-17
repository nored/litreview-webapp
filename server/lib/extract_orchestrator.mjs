// extract_orchestrator.mjs
//
// Runs the M2 per-paper extractor pipeline for a single paper, or for
// every eligible paper in the corpus. The order matters for one reason:
// the numerical results extractor attaches each `(metric, value)` row
// to a dataset by looking up `name_usage` rows for the paper — so
// named-entity extraction must run first.
//
// Order:
//
//   0. Ensure the paper row + chunks + section index exist in SQLite.
//      Calls into ingest.mjs to bridge from the file-based state if
//      they aren't already there.
//   1. Boolean signal extraction (claims_first_in_area, etc.).
//   2. Categorical extraction (methodology_type, system_domain,
//      sample_type).
//   3. Named-entity extraction (tech_stack, datasets_used,
//      frameworks_cited). Adds rows to name_usage.
//   4. Numerical extraction (sample_size, results). Reads name_usage
//      for dataset attachment.
//   5. Persist any vocabulary updates back to the seed JSON files.
//
// Every step writes through store.mjs; the orchestrator wraps the whole
// per-paper run in a single transaction so a mid-run failure rolls back
// cleanly. (Embedder / NLI / NER model calls themselves are outside the
// transaction — those don't touch SQLite.)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as store from './store.mjs';
import * as ingest from './ingest.mjs';
import { extractBoolSignals, SIGNAL_NAMES } from './extractors/bool_signals.mjs';
import { extractCategorical, CATEGORICAL_FIELDS } from './extractors/categorical.mjs';
import { extractNamedEntities, NAMED_ENTITY_FIELDS, saveDirtyVocabs } from './extractors/named_entities.mjs';
import { extractNumerical, NUMERICAL_FIELDS } from './extractors/numerical.mjs';
import { extractTopicEnums, TOPIC_ENUM_FIELDS } from './extractors/topic_enums.mjs';
import { extractTopicRelevance } from './extractors/topic_relevance.mjs';
import { DATA_DIR, PDFS_DIR } from '../paths.mjs';
import { ensureDir } from '../storage.mjs';

const EXTRACTION_LOG_PATH = path.join(DATA_DIR, '_extraction_log.jsonl');
const MAX_LOG_LINES = 1000;

async function appendExtractionLog(report) {
  try {
    await ensureDir(DATA_DIR);
    const line = JSON.stringify({
      paper_id: report.paper_id,
      started_at: report.started_at,
      finished_at: report.finished_at,
      elapsed_ms: report.elapsed_ms,
      errors: report.errors || [],
      skipped: report.skipped || null,
      skipped_reason: report.skipped_reason || null,
      steps: Object.fromEntries(
        Object.entries(report.steps || {}).map(([k, v]) => [
          k,
          { error: v?.error || null, populated: typeof v?.populated === 'number' ? v.populated : undefined },
        ]),
      ),
    });
    await fs.appendFile(EXTRACTION_LOG_PATH, line + '\n', 'utf8');
    // Rotate: trim to last MAX_LOG_LINES when the file grows past 1.5×.
    // Cheap check via lstat (size proxy) before reading the file.
    const st = await fs.stat(EXTRACTION_LOG_PATH).catch(() => null);
    if (st && st.size > 200 * MAX_LOG_LINES) {   // ~200 bytes/line is a generous estimate
      const text = await fs.readFile(EXTRACTION_LOG_PATH, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      if (lines.length > MAX_LOG_LINES) {
        const kept = lines.slice(-MAX_LOG_LINES).join('\n') + '\n';
        await fs.writeFile(EXTRACTION_LOG_PATH, kept, 'utf8');
      }
    }
  } catch (e) {
    console.warn('extraction log append failed:', e?.message || e);
  }
}

export async function readExtractionLog(opts = {}) {
  const limit = Math.max(1, Math.min(MAX_LOG_LINES, opts.limit ?? 100));
  try {
    const text = await fs.readFile(EXTRACTION_LOG_PATH, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const tail = lines.slice(-limit).reverse();
    const records = [];
    for (const line of tail) {
      try { records.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return records;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Per-paper orchestration
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run the full Stage 1 extractor pipeline for one paper. Idempotent —
 * re-running produces the same DB state (existing rows are overwritten).
 *
 * Pre-requisites the orchestrator satisfies for the caller:
 *   - `papers` row exists (via ingest.syncPapersFromCsv if needed)
 *   - `chunks` + `chunk_section` rows exist (via ingest.ingestChunksForPaper)
 *
 * Steps run sequentially (mostly because the model pipelines aren't
 * trivially parallelisable in @huggingface/transformers). Total cost
 * per paper at thesis scale: ~15-20s on a current laptop CPU.
 *
 * opts:
 *   skipIngest      — assume papers / chunks already populated; skip the
 *                     pre-flight ingestion. Use this in batch loops where
 *                     you've called syncPapersFromCsv() once up front.
 *   only            — subset of stages to run: ['bool', 'categorical',
 *                     'named_entities', 'numerical']. Default: all.
 *   verbose         — print progress + per-field summaries.
 */
export async function extractForPaper(paperId, opts = {}) {
  await store.init();
  const verbose = !!opts.verbose;
  const log = (...args) => { if (verbose) console.log(...args); };
  // onStep(stepName, paperId) — optional callback fired before each
  // stage so the corpus runner can surface "now running categorical
  // on paper_037" to the UI without waiting for the paper to finish.
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : null;
  const step = (name) => { if (onStep) try { onStep(name, paperId); } catch { /* ignore */ } };

  log(`[orchestrator] paper ${paperId} — start`);
  step('ingest_check');
  const startMs = Date.now();
  const report = {
    paper_id: paperId,
    started_at: new Date().toISOString(),
    steps: {},
    errors: [],
  };

  // 0. Ingestion pre-flight.
  if (!opts.skipIngest) {
    const paperRow = store.query('SELECT paper_id FROM papers WHERE paper_id = ?', [paperId]);
    if (paperRow.length === 0) {
      log(`[orchestrator] papers row missing for ${paperId} — syncing from CSV`);
      await ingest.syncPapersFromCsv();
      const stillMissing = store.query('SELECT paper_id FROM papers WHERE paper_id = ?', [paperId]);
      if (stillMissing.length === 0) {
        report.errors.push('paper_id not found in candidates_triaged.csv');
        return report;
      }
    }
    const haveChunks = store.query('SELECT COUNT(*) AS n FROM chunks WHERE paper_id = ?', [paperId]);
    if (!haveChunks[0] || haveChunks[0].n === 0) {
      log(`[orchestrator] no chunks for ${paperId} — running pdf_chunks + section_classifier`);
      const r = await ingest.ingestChunksForPaper(paperId);
      report.steps.ingest = r;
      if (r.error) {
        // PDF-not-found is an EXPECTED state: not every triaged paper
        // gets a downloadable PDF (paywalled, OA URL stale, download
        // daemon still working through the queue). Surface it as a
        // skip, not an error, so the UI doesn't flag the paper red.
        const expected = /pdf not found|no pdf on disk|enoent/i.test(r.error);
        if (expected) {
          report.skipped = 'pdf_not_available';
          report.skipped_reason = r.error;
        } else {
          report.errors.push('chunk ingestion failed: ' + r.error);
        }
        return report;
      }
    }
  }

  // Deep-read extraction is a purely discriminative pipeline. Every value
  // comes from regex / NER / NLI / embedding-cosine — mechanisms that
  // emit a probability or score we can render in the UI alongside the
  // verbatim source quote. No LLM is involved at this stage by design:
  // asking an LLM "what is this paper's methodology_type" produces an
  // opaque answer that breaks the explainability contract. AI is used
  // elsewhere — auto-seeding topic axes, claims extraction (WebLLM,
  // substring-validated), catalogue generation, positioning statements —
  // but never here.
  {
    const stages = new Set(opts.only?.length ? opts.only : ['topic_enums', 'topic_relevance', 'bool', 'categorical', 'named_entities', 'numerical']);

    if (stages.has('topic_enums')) {
      log(`[orchestrator] topic_enums (${TOPIC_ENUM_FIELDS.length} fields) ...`);
      step('topic_enums');
      try { report.steps.topic_enums = await extractTopicEnums(paperId, opts); }
      catch (e) { report.errors.push(`topic_enums: ${e?.message || e}`); }
    }
    if (stages.has('topic_relevance')) {
      log(`[orchestrator] topic_relevance ...`);
      step('topic_relevance');
      try { report.steps.topic_relevance = await extractTopicRelevance(paperId, opts); }
      catch (e) { report.errors.push(`topic_relevance: ${e?.message || e}`); }
    }
    if (stages.has('bool')) {
      log(`[orchestrator] bool_signals (${SIGNAL_NAMES.length} fields) ...`);
      step('bool');
      try { report.steps.bool = await extractBoolSignals(paperId, opts); }
      catch (e) { report.errors.push(`bool_signals: ${e?.message || e}`); }
    }
    if (stages.has('categorical')) {
      log(`[orchestrator] categorical (${CATEGORICAL_FIELDS.length} fields) ...`);
      step('categorical');
      try { report.steps.categorical = await extractCategorical(paperId, opts); }
      catch (e) { report.errors.push(`categorical: ${e?.message || e}`); }
    }
    if (stages.has('named_entities')) {
      log(`[orchestrator] named_entities (${NAMED_ENTITY_FIELDS.length} fields) ...`);
      step('named_entities');
      try { report.steps.named_entities = await extractNamedEntities(paperId, opts); }
      catch (e) { report.errors.push(`named_entities: ${e?.message || e}`); }
    }
    if (stages.has('numerical')) {
      log(`[orchestrator] numerical (${NUMERICAL_FIELDS.length} fields) ...`);
      step('numerical');
      try { report.steps.numerical = await extractNumerical(paperId, opts); }
      catch (e) { report.errors.push(`numerical: ${e?.message || e}`); }
    }
  }

  // 5. Stamp the extraction time so detectors can flag stale dashboards.
  store.exec(
    `INSERT INTO schema_meta (key, value) VALUES ('last_extracted_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [new Date().toISOString()],
  );

  // 6. Force a DB flush so the run survives an immediate process exit.
  await store.flush();

  report.elapsed_ms = Date.now() - startMs;
  report.finished_at = new Date().toISOString();
  log(`[orchestrator] paper ${paperId} — done in ${report.elapsed_ms}ms`);
  await appendExtractionLog(report);
  return report;
}

// ─────────────────────────────────────────────────────────────────────────
// Batch orchestration
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run extractForPaper across every eligible paper in the corpus, one at
 * a time. After every paper, persist any vocabulary updates so the next
 * paper benefits from learned entries (and a mid-batch crash leaves the
 * vocab in a consistent state).
 *
 * Eligible = include / maybe triage label + has a PDF (verified by
 * chunk ingestion succeeding).
 *
 * opts:
 *   onProgress     — async (report) => void; called after each paper
 *   ids            — array of paper_ids to limit the batch; default all
 */
export async function extractCorpus(opts = {}) {
  await store.init();
  // Pre-flight: ensure papers table is in sync with triage CSV.
  const syncReport = await ingest.syncPapersFromCsv();

  // Pick the set to extract over.
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

  // Filter to papers whose PDF is actually on disk. Otherwise we waste
  // an hour iterating through hundreds of paywalled rows that have
  // nothing to extract. Scan the PDFs directory ONCE (cheap) instead
  // of stat'ing per paper.
  try {
    const onDisk = new Set();
    const files = await fs.readdir(PDFS_DIR);
    for (const f of files) {
      const m = /^paper_(.+)\.pdf$/.exec(f);
      if (m) onDisk.add(m[1]);
    }
    const before = rows.length;
    rows = rows.filter((r) => onDisk.has(String(r.paper_id)));
    if (rows.length < before) {
      console.log(`[orchestrator] skipping ${before - rows.length} paper(s) with no PDF on disk; extracting ${rows.length}`);
    }
  } catch (e) {
    console.warn('[orchestrator] could not read PDFs dir:', e?.message || e);
  }

  const batchReport = {
    started_at: new Date().toISOString(),
    sync: syncReport,
    total: rows.length,
    completed: [],
    failed: [],
  };
  // Fire onStart so the API can populate job.total and the UI can show
  // "0 of 414" instead of "0 of 0" during the cold-start window before
  // the first paper completes.
  if (typeof opts.onStart === 'function') {
    try { await opts.onStart({ total: rows.length, ids: rows.map((r) => r.paper_id) }); } catch { /* ignore */ }
  }

  // Concurrency. The local pipeline is CPU-bound on a single ONNX
  // runtime — the NLI/NER pipelines aren't trivially thread-safe, so
  // we keep concurrency at 1 by default. The user can raise it if they
  // have enough cores and accept the contention.
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 1));

  let done = 0;
  let cursor = 0;
  async function worker(_id) {
    while (true) {
      if (opts.signal?.aborted) return;
      const i = cursor++;
      if (i >= rows.length) return;
      const paperId = rows[i].paper_id;
      try {
        const r = await extractForPaper(paperId, opts);
        batchReport.completed.push({ paper_id: paperId, elapsed_ms: r.elapsed_ms, errors: r.errors });
        // Persist vocab additions per paper; idempotent when nothing changed.
        const saved = await saveDirtyVocabs();
        if (saved.length > 0) console.log('[orchestrator] saved vocabs:', saved.join(', '));
        done++;
        if (opts.onProgress) await opts.onProgress(r, done, rows.length);
      } catch (e) {
        batchReport.failed.push({ paper_id: paperId, error: e?.message || String(e) });
        done++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  if (opts.signal?.aborted) {
    batchReport.aborted = true;
    batchReport.aborted_after = done;
  }
  batchReport.concurrency = concurrency;
  batchReport.finished_at = new Date().toISOString();
  return batchReport;
}

// Re-exports so callers can use a single import surface.
export {
  SIGNAL_NAMES,
  CATEGORICAL_FIELDS,
  NAMED_ENTITY_FIELDS,
  NUMERICAL_FIELDS,
  TOPIC_ENUM_FIELDS,
  saveDirtyVocabs,
};
