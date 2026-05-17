#!/usr/bin/env node
// Standalone accuracy-test bench. Imports the pipeline modules
// directly. No HTTP. No live server required.
//
// Runs:
//   1. grobid-ingest for every paper in sample.txt
//   2. extractPhase2ForPaper with provider='webllm' (Node llama.cpp)
//   3. generatePhase3Embeddings + runPhase3Clustering once
//   4. detectAllPhase4 once and persist to project/data/_phase4_last.json
//
// Skips per-paper Phase 2 if claims already exist for that paper
// (resume-safe across crashes). Logs to tests/quality/_bench_log.jsonl.
//
// IMPORTANT: kill the dev server before running — Metal can only load
// the GGUF model once at a time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from '../../server/lib/store.mjs';
import * as llmLocal from '../../server/lib/llm_local.mjs';
import { ingestPaperGrobid } from '../../server/lib/ingest_grobid.mjs';
import { extractPhase2ForPaper } from '../../server/lib/extract_phase2.mjs';
import { generatePhase3Embeddings } from '../../server/lib/embed_phase3.mjs';
import { runPhase3Clustering } from '../../server/lib/cluster_phase3.mjs';
import { detectAllPhase4 } from '../../server/lib/detect_phase4.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SAMPLE = path.join(__dirname, 'sample.txt');
const LOG = path.join(__dirname, '_bench_log.jsonl');
const PHASE4_OUT = path.join(ROOT, 'project', 'data', '_phase4_last.json');

const ids = fs.readFileSync(SAMPLE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
if (ids.length === 0) { console.error('sample.txt empty'); process.exit(1); }

fs.writeFileSync(LOG, '');
function log(rec) {
  rec.t = new Date().toISOString();
  const line = JSON.stringify(rec);
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function ensureModelLoaded() {
  log({ event: 'llm-restore-start' });
  await llmLocal.bootRestore();
  let last = null;
  for (let i = 0; i < 600; i += 1) {
    const s = llmLocal.getStatus();
    if (s.state !== last) { log({ event: 'llm-status', ...s }); last = s.state; }
    if (s.state === 'ready') return;
    if (s.state === 'error') throw new Error(`llm load failed: ${s.error}`);
    await sleep(1000);
  }
  throw new Error('llm load did not become ready within 10 minutes');
}

async function papersWithClaims() {
  await store.init();
  const rows = store.query('SELECT DISTINCT paper_id FROM claims WHERE paper_id IN (' + ids.map(() => '?').join(',') + ')', ids);
  return new Set(rows.map((r) => r.paper_id));
}

async function main() {
  log({ event: 'start', papers: ids.length });
  await store.init();
  await ensureModelLoaded();

  const alreadyDone = await papersWithClaims();
  log({ event: 'resume-skip', already_extracted: [...alreadyDone] });

  for (const id of ids) {
    if (alreadyDone.has(id)) continue;
    const t0 = Date.now();
    try {
      const g = await ingestPaperGrobid(id);
      log({ event: 'grobid', id, ok: true, ms: Date.now() - t0, sections: g?.sections?.length, paragraphs: g?.paragraphs?.length });
    } catch (e) {
      log({ event: 'grobid', id, ok: false, error: e.message, ms: Date.now() - t0 });
      continue;
    }
    const t1 = Date.now();
    try {
      const r = await extractPhase2ForPaper(id, { provider: 'webllm' });
      log({ event: 'phase2', id, ok: true, ms: Date.now() - t1,
            entities: r?.steps?.entities?.n_spans,
            claims: r?.steps?.claims?.total_accepted,
            claims_rejected: r?.steps?.claims?.total_rejected,
            numerical: r?.steps?.numerical?.total_accepted,
            stance_classified: r?.steps?.stance?.classified,
            stance_total: r?.steps?.stance?.total });
    } catch (e) {
      log({ event: 'phase2', id, ok: false, error: e.message, ms: Date.now() - t1 });
    }
  }

  // Phase 3.
  const t3a = Date.now();
  try {
    const e = await generatePhase3Embeddings({});
    log({ event: 'embed-phase3', ok: true, ms: Date.now() - t3a, ...e });
  } catch (e) { log({ event: 'embed-phase3', ok: false, error: e.message }); }
  const t3b = Date.now();
  try {
    const c = await runPhase3Clustering({});
    log({ event: 'cluster-phase3', ok: true, ms: Date.now() - t3b, summary: c?.summary });
  } catch (e) { log({ event: 'cluster-phase3', ok: false, error: e.message }); }

  // Phase 4.
  const t4 = Date.now();
  try {
    const r = await detectAllPhase4({});
    fs.writeFileSync(PHASE4_OUT, JSON.stringify(r, null, 2));
    log({ event: 'detect-phase4', ok: true, ms: Date.now() - t4, summary: r?.summary });
  } catch (e) { log({ event: 'detect-phase4', ok: false, error: e.message }); }

  log({ event: 'done' });
  await store.close();
  process.exit(0);
}

main().catch((err) => { log({ event: 'fatal', error: err.message }); process.exit(1); });
